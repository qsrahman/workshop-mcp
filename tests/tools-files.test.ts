import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Client } from '@modelcontextprotocol/client'
import { callError, callTool, connect, dir } from './harness.js'

describe('edit_file arguments', () => {
  it('rejects an empty edits list at the schema and leaves the file alone', async () => {
    const client = await connect()
    const file = path.join(dir, 'note.txt')
    const result = await client
      .callTool({ name: 'edit_file', arguments: { path: file, edits: [] } })
      .catch(() => ({ isError: true }))
    expect(result.isError).toBe(true)
    expect(await fs.readFile(file, 'utf-8')).toBe('original')
  })

  it('shows the path the client sent in the diff, not the resolved one', async () => {
    const client = await connect()
    const result = await client.callTool({
      name: 'edit_file',
      arguments: {
        path: 'note.txt',
        edits: [{ oldText: 'original', newText: 'changed' }],
        dryRun: true,
      },
    })
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).toContain('--- note.txt')
    expect(text).not.toContain(dir)
  })
})

describe('read_multiple_files budget', () => {
  it('cuts a file that does not fit in the shared budget, with where to continue', async () => {
    const client = await connect()
    const row = 'x'.repeat(99) + '\n'
    await fs.writeFile(path.join(dir, 'one.txt'), row.repeat(1500)) // 150,000 chars
    await fs.writeFile(path.join(dir, 'two.txt'), row.repeat(1500))
    const result = await client.callTool({
      name: 'read_multiple_files',
      arguments: {
        paths: [
          path.join(dir, 'one.txt'),
          path.join(dir, 'note.txt'),
          path.join(dir, 'two.txt'),
        ],
      },
    })
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).toContain('note.txt:\noriginal')
    expect(text).toContain('Continue by reading this file with offset=')
    expect(text.length).toBeLessThan(200_500)
  })
})

describe('read_multiple_files, once the budget is used up', () => {
  it('skips the remaining files and says how to read them', async () => {
    const client = await connect()
    // exactly the call's 200,000-character budget: nothing is left for note.txt
    await fs.writeFile(
      path.join(dir, 'big.txt'),
      ('x'.repeat(99) + '\n').repeat(2000),
    )
    const result = await client.callTool({
      name: 'read_multiple_files',
      arguments: {
        paths: [path.join(dir, 'big.txt'), path.join(dir, 'note.txt')],
      },
    })
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).toContain(
      `${path.join(dir, 'note.txt')}: Skipped - the size limit for this call was reached; read it on its own`,
    )
    expect(text).not.toContain('original')
  })
})

describe('read_file tail', () => {
  it('returns the last lines through the tool', async () => {
    const client = await connect()
    await fs.writeFile(path.join(dir, 'lines.txt'), 'a\nb\nc\nd\n')
    const result = await client.callTool({
      name: 'read_file',
      arguments: { path: path.join(dir, 'lines.txt'), tail: 2 },
    })
    expect((result.content as Array<{ text: string }>)[0].text).toBe('c\nd')
  })
})

describe('write_file', () => {
  it('creates missing parent directories', async () => {
    const client = await connect()
    const result = await client.callTool({
      name: 'write_file',
      arguments: { path: path.join(dir, 'new', 'deep', 'f.ts'), content: 'x' },
    })
    expect(result.isError).toBeFalsy()
    expect(await fs.readFile(path.join(dir, 'new/deep/f.ts'), 'utf-8')).toBe(
      'x',
    )
  })

  it('creates them relative to the working directory', async () => {
    const client = await connect()
    await client.callTool({
      name: 'write_file',
      arguments: { path: 'rel/dir/g.ts', content: 'y' },
    })
    expect(await fs.readFile(path.join(dir, 'rel/dir/g.ts'), 'utf-8')).toBe('y')
  })

  it("names the caller's path when refusing a directory", async () => {
    const client = await connect()
    await fs.mkdir(path.join(dir, 'sub'))
    const message = await callError(client, 'write_file', {
      path: 'sub',
      content: 'x',
    })
    expect(message).toBe('Refusing to write: sub is not a regular file')
    expect(message).not.toContain(dir)
  })
})

describe('read_file for agents', () => {
  const read = (client: Client, args: Record<string, unknown>) =>
    callTool(client, 'read_file', args)

  it('reads a range with offset and limit', async () => {
    const client = await connect()
    await fs.writeFile(
      path.join(dir, 'ten.txt'),
      Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n') + '\n',
    )
    const { text } = await read(client, {
      path: path.join(dir, 'ten.txt'),
      offset: 4,
      limit: 3,
    })
    expect(text).toMatch(
      /^l4\nl5\nl6\n\[\.\.\. showing lines 4-6; more lines follow\. Continue by reading this file with offset=7\]$/,
    )
  })

  it('caps a long file and says where to continue', async () => {
    const client = await connect()
    await fs.writeFile(
      path.join(dir, 'long.txt'),
      ('y'.repeat(79) + '\n').repeat(5000),
    ) // 400,000 chars
    const { text } = await read(client, { path: path.join(dir, 'long.txt') })
    expect(text.length).toBeLessThan(101_000)
    expect(text).toMatch(/Continue by reading this file with offset=\d+\]$/)
  })

  it('rejects combining head, tail and offset/limit', async () => {
    const client = await connect()
    const file = path.join(dir, 'note.txt')
    for (const extra of [
      { head: 1, offset: 1 },
      { tail: 1, limit: 1 },
      { head: 1, tail: 1 },
    ]) {
      expect((await read(client, { path: file, ...extra })).isError).toBe(true)
    }
  })

  it("explains a directory, a missing file and a binary file in the caller's words", async () => {
    const client = await connect()
    await fs.mkdir(path.join(dir, 'sub'))
    await fs.writeFile(path.join(dir, 'blob.bin'), Buffer.from([1, 0, 2, 0, 3]))
    expect((await read(client, { path: 'sub' })).text).toBe(
      'sub is a directory, not a file',
    )
    expect((await read(client, { path: 'missing/none.txt' })).text).toBe(
      'File not found: missing/none.txt',
    )
    expect((await read(client, { path: 'blob.bin' })).text).toBe(
      'blob.bin looks like a binary file or is not valid UTF-8 text',
    )
  })
})

describe('edit_file ambiguity', () => {
  const call = (client: Client, args: Record<string, unknown>) =>
    client.callTool({ name: 'edit_file', arguments: args })

  it('refuses an oldText that matches several places and writes nothing', async () => {
    const client = await connect()
    const file = path.join(dir, 'dup.txt')
    await fs.writeFile(file, 'a=1\nb=1\na=1\n')
    const result = await call(client, {
      path: file,
      edits: [{ oldText: 'a=1', newText: 'a=2' }],
    })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0].text).toContain(
      'matches 2 places (lines 1, 3)',
    )
    expect(await fs.readFile(file, 'utf-8')).toBe('a=1\nb=1\na=1\n')
  })

  it("names the caller's path when refusing a binary file", async () => {
    const client = await connect()
    await fs.writeFile(path.join(dir, 'blob.bin'), Buffer.from([0xff]))
    const message = await callError(client, 'edit_file', {
      path: 'blob.bin',
      edits: [{ oldText: 'x', newText: 'y' }],
    })
    expect(message).toBe(
      'blob.bin looks like a binary file or is not valid UTF-8 text',
    )
    expect(message).not.toContain(dir)
  })

  it('replaces every match with replaceAll', async () => {
    const client = await connect()
    const file = path.join(dir, 'dup.txt')
    await fs.writeFile(file, 'a=1\nb=1\na=1\n')
    const result = await call(client, {
      path: file,
      edits: [{ oldText: 'a=1', newText: 'a=2', replaceAll: true }],
    })
    expect(result.isError).toBeFalsy()
    expect(await fs.readFile(file, 'utf-8')).toBe('a=2\nb=1\na=2\n')
  })
})

describe('path resolution errors', () => {
  it("names the caller's path when a parent is not a directory", async () => {
    await fs.writeFile(path.join(dir, 'plain'), 'x')
    const client = await connect()
    const target = 'plain/child.txt'
    for (const [tool, args] of [
      ['read_file', { path: target }],
      ['read_multiple_files', { paths: [target] }],
      ['write_file', { path: target, content: 'y' }],
      ['edit_file', { path: target, edits: [{ oldText: 'x', newText: 'y' }] }],
    ] as const) {
      const message = await callError(client, tool, args)
      expect(message, tool).toContain(
        `A parent of ${target} is not a directory`,
      )
      expect(message, tool).not.toContain(dir)
    }
  })
})

describe('symlink errors', () => {
  it('calls a loop a loop, whichever tool runs into it', async () => {
    await fs.symlink('loop2', path.join(dir, 'loop1'))
    await fs.symlink('loop1', path.join(dir, 'loop2'))
    const client = await connect()
    for (const [tool, args] of [
      ['read_file', { path: 'loop1' }],
      ['write_file', { path: 'loop1', content: 'y' }],
      ['shell', { command: 'pwd', cwd: 'loop1' }],
    ] as const) {
      expect(await callError(client, tool, args), tool).toBe(
        'Too many symbolic links (do they form a loop?): loop1',
      )
    }
  })

  it('does not call the last name the broken link when an earlier one is', async () => {
    await fs.symlink('nowhere', path.join(dir, 'dangling'))
    const message = await callError(await connect(), 'read_file', {
      path: 'dangling/sub/f.txt',
    })
    expect(message).toBe(
      'dangling/sub/f.txt goes through a broken symlink (its target does not exist)',
    )
  })
})

describe('concurrent calls', () => {
  it('applies parallel edits to different lines of one file without losing any', async () => {
    const client = await connect()
    const file = path.join(dir, 'parallel.txt')
    for (let round = 0; round < 10; round++) {
      await fs.writeFile(file, 'a\nb\nc\nd\n'.repeat(20))
      const edit = (oldText: string, newText: string) =>
        client.callTool({
          name: 'edit_file',
          arguments: {
            path: file,
            edits: [{ oldText, newText, replaceAll: true }],
          },
        })
      await Promise.all([edit('a\nb', 'A\nB'), edit('c\nd', 'C\nD')])
      expect(await fs.readFile(file, 'utf-8')).toMatch(/^A\nB\nC\nD\n/)
    }
  })
})
