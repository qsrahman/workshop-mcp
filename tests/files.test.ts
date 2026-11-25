import { execFileSync } from 'node:child_process'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validatePath } from '../src/paths.js'
import {
  friendlyFsError,
  readText,
  readWholeTextFile,
  tailFile,
  withFileLock,
  writeFileContent,
} from '../src/files.js'
import { makeTempDirs, removeTempDirs } from './helpers.js'

let root: string
let outside: string

beforeEach(async () => ({ root, outside } = await makeTempDirs()))
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await removeTempDirs(root, outside)
})

describe('writeFileContent', () => {
  it('creates, overwrites, and refuses non-regular files', async () => {
    const f = path.join(root, 'f.txt')
    await writeFileContent(f, 'one')
    await writeFileContent(f, 'two')
    expect(await fs.readFile(f, 'utf-8')).toBe('two')
    await fs.mkdir(path.join(root, 'd'))
    await expect(writeFileContent(path.join(root, 'd'), 'x')).rejects.toThrow()
  })

  it('creates missing parent directories', async () => {
    const f = path.join(root, 'new', 'deep', 'f.txt')
    await writeFileContent(f, 'hi')
    expect(await fs.readFile(f, 'utf-8')).toBe('hi')
  })

  it('fails clearly when a parent is a file', async () => {
    await fs.writeFile(path.join(root, 'plain'), 'x')
    await expect(
      writeFileContent(path.join(root, 'plain', 'child.txt'), 'y'),
    ).rejects.toThrow()
  })

  it('does not write through a symlink', async () => {
    const target = path.join(outside, 't')
    await fs.writeFile(target, 'keep')
    await fs.symlink(target, path.join(root, 'l'))
    await expect(
      writeFileContent(path.join(root, 'l'), 'bad'),
    ).rejects.toThrow()
    expect(await fs.readFile(target, 'utf-8')).toBe('keep')
  })
})

describe('readText', () => {
  const lines = (n: number) =>
    Array.from({ length: n }, (_, i) => `line ${i + 1}`)
  const write = async (name: string, content: string) => {
    const f = path.join(root, name)
    await fs.writeFile(f, content)
    return f
  }

  it('returns a small file byte for byte', async () => {
    const f = await write('small.txt', 'a\r\nb\n')
    expect(await readText(f)).toBe('a\r\nb\n')
  })

  it('reads a range with offset and limit', async () => {
    const f = await write('range.txt', lines(10).join('\n') + '\n')
    expect(await readText(f, { offset: 3, limit: 2 })).toMatch(
      /^line 3\nline 4\n\[\.\.\. showing lines 3-4; more lines follow\. Continue by reading this file with offset=5\]$/,
    )
    expect(await readText(f, { offset: 9 })).toBe('line 9\nline 10')
    expect(await readText(f, { offset: 11 })).toContain(
      'past the end of the file, which has 10 lines',
    )
  })

  it('returns the first N lines with limit, normalizing CRLF', async () => {
    const f = await write('l.txt', 'a\r\nb\r\nc\r\nd\n')
    expect(await readText(f, { limit: 2 })).toMatch(
      /^a\nb\n\[\.\.\. showing lines 1-2/,
    )
    expect(await readText(f, { limit: 4 })).toBe('a\nb\nc\nd')
  })

  it('cuts a long file at a line boundary and says where to continue', async () => {
    const f = await write('long.txt', lines(5000).join('\n') + '\n')
    const text = await readText(f, { maxChars: 1000 })
    const note = text.match(
      /\[\.\.\. showing lines 1-(\d+); more lines follow\. Continue by reading this file with offset=(\d+)\]$/,
    )
    expect(note).not.toBeNull()
    expect(Number(note![2])).toBe(Number(note![1]) + 1)
    const body = text.slice(0, note!.index).trimEnd()
    expect(body.length).toBeLessThanOrEqual(1000)
    expect(body.split('\n')).toEqual(lines(Number(note![1])))
    // continuing from the note picks up at the next line
    expect(
      (await readText(f, { offset: Number(note![2]), limit: 1 })).split(
        '\n',
      )[0],
    ).toBe(`line ${note![2]}`)
  })

  it('cuts one line that is longer than the whole budget instead of skipping it', async () => {
    const f = await write('wide.txt', 'x'.repeat(5000) + '\nnext\n')
    const text = await readText(f, { maxChars: 100 })
    expect(text.startsWith('x'.repeat(100))).toBe(true)
    expect(text).toContain('line cut: it has 5000 characters')
    expect(text).toContain('Continue by reading this file with offset=2')
  })

  it('reads a file far past the old whole-file limit by the first part', async () => {
    const f = path.join(root, 'huge.txt')
    await fs.writeFile(f, 'a\n'.repeat(6 * 1024 * 1024))
    const text = await readText(f)
    expect(text.length).toBeLessThan(101_000)
    expect(text).toContain('more lines follow')
  })

  it('opens a file once and closes that handle, whichever way it reads', async () => {
    const f = await write('once.txt', lines(3000).join('\n') + '\n')
    const open = vi.spyOn(fs, 'open')
    try {
      await readText(f) // whole file (fits)
      await readText(f, { maxChars: 500 }) // streamed
      await tailFile(f, 5)
      expect(open).toHaveBeenCalledTimes(3)
    } finally {
      open.mockRestore()
    }
  })

  it('closes its file descriptor on an early exit', async () => {
    const f = await write('big.txt', 'x\n'.repeat(200_000))
    const open = async () => (await fs.readdir('/dev/fd')).length
    const before = await open()
    for (let i = 0; i < 30; i++) await readText(f, { limit: 1 })
    await sleep(100)
    expect(await open()).toBeLessThan(before + 5)
  })

  it('refuses a directory and a binary file with recognisable codes', async () => {
    await fs.mkdir(path.join(root, 'dir'))
    await expect(readText(path.join(root, 'dir'))).rejects.toMatchObject({
      code: 'EISDIR',
    })
    const bin = path.join(root, 'blob.bin')
    await fs.writeFile(bin, Buffer.from([0x68, 0x00, 0x69, 0x0a]))
    await expect(readText(bin)).rejects.toMatchObject({ code: 'EBINARY' })
    await expect(tailFile(bin, 1)).rejects.toMatchObject({ code: 'EBINARY' })
  })

  // Nothing is restricted, so a model can name a device or a pipe: /dev/zero
  // has size 0 and would be read without end, and a pipe with no writer never
  // finishes opening.
  it.runIf(fsSync.existsSync('/dev/zero'))(
    'refuses a device instead of reading it without end',
    async () => {
      await expect(readText('/dev/zero')).rejects.toMatchObject({
        code: 'ENOTFILE',
      })
      await expect(tailFile('/dev/zero', 1)).rejects.toMatchObject({
        code: 'ENOTFILE',
      })
      await expect(readWholeTextFile('/dev/zero')).rejects.toMatchObject({
        code: 'ENOTFILE',
      })
    },
  )

  it.runIf(process.platform !== 'win32')(
    'refuses a pipe with no writer without waiting for one',
    async () => {
      const fifo = path.join(root, 'pipe')
      execFileSync('mkfifo', [fifo])
      await expect(readText(fifo)).rejects.toMatchObject({ code: 'ENOTFILE' })
    },
    5000,
  )

  it('refuses text that is not valid UTF-8, such as Latin-1', async () => {
    const f = path.join(root, 'latin1.txt')
    await fs.writeFile(f, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])) // "café" in Latin-1
    await expect(readText(f)).rejects.toMatchObject({ code: 'EBINARY' })
  })

  // Reading is lossy and harmless: a log with one stray byte is still worth
  // reading. Only writing back (edit_file) needs every byte to be valid.
  it('reads a file with invalid UTF-8 after the first 8 KB, showing U+FFFD', async () => {
    const f = path.join(root, 'late.log')
    await fs.writeFile(
      f,
      Buffer.concat([
        Buffer.alloc(9000, 0x61),
        Buffer.from([0xe9, 0x0a]),
        Buffer.from('last line\n'),
      ]),
    )
    expect(await readText(f)).toContain('\uFFFD')
    expect(await tailFile(f, 1)).toBe('last line')
  })

  it('refuses invalid UTF-8 anywhere when the whole file is read for editing', async () => {
    const f = path.join(root, 'late.bin')
    await fs.writeFile(
      f,
      Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0xff, 0xfe])]),
    )
    await expect(readWholeTextFile(f)).rejects.toMatchObject({
      code: 'EBINARY',
    })
    const ok = path.join(root, 'ok.txt')
    await fs.writeFile(ok, 'héllo\n')
    expect(await readWholeTextFile(ok)).toBe('héllo\n')
  })

  it('reports a read error as itself, not as a binary file', async () => {
    const f = await write('io.txt', 'abc')
    const close = vi.fn(async () => {})
    const open = vi.spyOn(fs, 'open').mockResolvedValue({
      stat: async () => ({
        isDirectory: () => false,
        isFile: () => true,
        size: 3,
      }),
      read: async () => {
        throw Object.assign(new Error('input/output error'), { code: 'EIO' })
      },
      close,
    } as never)
    try {
      await expect(readText(f)).rejects.toMatchObject({ code: 'EIO' })
      expect(close).toHaveBeenCalled()
    } finally {
      open.mockRestore()
    }
  })

  it('accepts UTF-8 whose multi-byte character straddles the 8 KB boundary', async () => {
    const f = path.join(root, 'edge.txt')
    await fs.writeFile(f, 'a'.repeat(8191) + 'é€' + 'b'.repeat(500) + '\n')
    const text = await readText(f, { maxChars: 100 })
    expect(text).toContain('a'.repeat(50))
    await expect(readText(f, { offset: 1, limit: 1 })).resolves.toContain('é€')
  })

  it('does not read through a symlink swapped in after validation', async () => {
    const victim = path.join(root, 'victim.txt')
    const secret = path.join(outside, 'secret.txt')
    await fs.writeFile(victim, 'safe')
    await fs.writeFile(secret, 'TOP-SECRET')
    const validated = await validatePath(victim)
    const original = fs.realpath
    const swap = vi
      .spyOn(fs, 'realpath')
      .mockImplementation((target, ...rest) => {
        if (String(target) === victim) {
          fsSync.unlinkSync(victim)
          fsSync.symlinkSync(secret, victim)
          return Promise.resolve(validated) as never
        }
        return original(target, ...rest) as never
      })
    try {
      await expect(validatePath(victim)).resolves.toBe(validated)
    } finally {
      swap.mockRestore()
    }
    await expect(readText(validated)).rejects.toMatchObject({ code: 'ELOOP' })
  })
})

describe('tailFile', () => {
  it('returns the last N lines, and nothing for 0', async () => {
    const f = path.join(root, 'l.txt')
    await fs.writeFile(f, 'a\r\nb\r\nc\r\nd\n')
    expect(await tailFile(f, 2)).toBe('c\nd')
    expect(await tailFile(f, 0)).toBe('')
    expect(await tailFile(f, 10)).toBe('a\nb\nc\nd')
  })

  it('tails across chunk boundaries, with multi-byte text and no final newline', async () => {
    const f = path.join(root, 'many.txt')
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i} é€`)
    await fs.writeFile(f, lines.join('\n'))
    expect(await tailFile(f, 3)).toBe(lines.slice(-3).join('\n'))
    await fs.writeFile(f, lines.join('\n') + '\n')
    expect(await tailFile(f, 3)).toBe(lines.slice(-3).join('\n'))
    expect(await tailFile(f, 50_000, 10_000_000)).toBe(lines.join('\n'))
  })

  it('returns the end of a last line that is longer than the window it reads', async () => {
    const f = path.join(root, 'one-line.json')
    await fs.writeFile(f, '{"a":"' + 'x'.repeat(1_000_000) + '"}')
    const text = await tailFile(f, 1, 1000)
    expect(text).toContain('showing only the last 1000 characters')
    expect(text.endsWith('xxx"}')).toBe(true)
    await fs.writeFile(f, 'first\n' + 'y'.repeat(1_000_000))
    const last = await tailFile(f, 1, 1000)
    expect(last).toContain('showing only the last 1000 characters')
    expect(last.endsWith('yyy')).toBe(true)
    expect(last).not.toContain('first')
  })

  it('caps a huge tail request at maxChars without reading the whole file', async () => {
    const f = path.join(root, 'tail-cap.txt')
    await fs.writeFile(f, 'some log line\n'.repeat(100_000))
    const text = await tailFile(f, 1_000_000, 500)
    expect(text).toContain('showing only the last 500 characters')
    expect(text.length).toBeLessThan(600)
    expect(text.endsWith('some log line')).toBe(true)
  })
})

describe('friendlyFsError', () => {
  it('names the path as the caller wrote it for common fs failures', () => {
    const shown = 'src/a.ts'
    const code = (c: string) => Object.assign(new Error(c), { code: c })
    expect(friendlyFsError(code('ENOENT'), shown).message).toBe(
      'File not found: src/a.ts',
    )
    expect(friendlyFsError(code('EISDIR'), shown).message).toBe(
      'src/a.ts is a directory, not a file',
    )
    expect(friendlyFsError(code('ENOTDIR'), shown).message).toContain(
      'not a directory',
    )
    expect(friendlyFsError(code('EACCES'), shown).message).toBe(
      'Permission denied: src/a.ts',
    )
    expect(friendlyFsError(code('EPERM'), shown).message).toBe(
      'Permission denied: src/a.ts',
    )
    expect(friendlyFsError(code('EBINARY'), shown).message).toContain(
      'binary file',
    )
    expect(friendlyFsError(code('ELOOP'), shown).message).toBe(
      'Refusing to read a symbolic link: src/a.ts',
    )
    expect(friendlyFsError(code('ENOTFILE'), shown).message).toBe(
      'Refusing to read: src/a.ts is not a regular file (it is a device, pipe or socket)',
    )
    expect(friendlyFsError(code('ENOTREG'), shown).message).toBe(
      'Refusing to write: src/a.ts is not a regular file',
    )
  })

  it('passes other errors through unchanged', () => {
    const error = new Error('Broken symlink (its target does not exist): /x')
    expect(friendlyFsError(error, 'x')).toBe(error)
  })
})

describe('withFileLock', () => {
  it('runs calls with the same key one after another, in order', async () => {
    const events: string[] = []
    const task = (name: string, ms: number) =>
      withFileLock('k', async () => {
        events.push(`start ${name}`)
        await sleep(ms)
        events.push(`end ${name}`)
      })
    await Promise.all([task('a', 30), task('b', 1), task('c', 1)])
    expect(events).toEqual([
      'start a',
      'end a',
      'start b',
      'end b',
      'start c',
      'end c',
    ])
  })

  it('does not block other keys', async () => {
    const events: string[] = []
    await Promise.all([
      withFileLock('x', async () => {
        await sleep(40)
        events.push('x')
      }),
      withFileLock('y', async () => {
        events.push('y')
      }),
    ])
    expect(events).toEqual(['y', 'x'])
  })

  it('keeps going after a failure, and returns the failure to its own caller', async () => {
    const failing = withFileLock('k', async () => {
      throw new Error('boom')
    })
    const next = withFileLock('k', async () => 'ok')
    await expect(failing).rejects.toThrow('boom')
    expect(await next).toBe('ok')
  })

  it('keeps concurrent writers of one file from overwriting each other', async () => {
    const f = path.join(root, 'counter.txt')
    await fs.writeFile(f, '0')
    const bump = () =>
      withFileLock(f, async () => {
        const n = Number(await fs.readFile(f, 'utf-8'))
        await sleep(5)
        await writeFileContent(f, String(n + 1))
      })
    await Promise.all(Array.from({ length: 10 }, bump))
    expect(await fs.readFile(f, 'utf-8')).toBe('10')
  })
})
