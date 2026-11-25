import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { makeTempDirs, removeTempDirs } from './helpers.js'

// These run the built package as a separate process, the way an MCP client
// does, so they need `pnpm build` first (`pnpm validate` does it).
const entry = path.resolve('dist/index.js')

describe('the built server process', () => {
  let root: string
  let outside: string
  let bin: string

  beforeAll(async () => {
    if (!existsSync(entry)) {
      throw new Error(`${entry} is missing: run pnpm build before pnpm test`)
    }
    ;({ root, outside } = await makeTempDirs())
    await fs.writeFile(path.join(root, 'note.txt'), 'hello from a file')
    // npm starts a package's bin through a symlink; the entry-point check in
    // index.ts has to see through it, or the server silently never starts.
    bin = path.join(outside, 'workshop-mcp')
    await fs.symlink(entry, bin)
  })
  afterAll(() => removeTempDirs(root, outside))

  async function withClient<T>(
    program: string,
    args: string[],
    use: (client: Client) => Promise<T>,
  ): Promise<T> {
    const client = new Client({ name: 'cli-test', version: '0.0.0' })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [program, ...args],
        stderr: 'ignore',
      }),
    )
    try {
      return await use(client)
    } finally {
      await client.close()
    }
  }

  const toolNames = async (client: Client) =>
    (await client.listTools()).tools.map((tool) => tool.name).sort()

  it('starts through a symlink, lists its tools and reads a file', async () => {
    await withClient(bin, [], async (client) => {
      expect(await toolNames(client)).toEqual([
        'edit_file',
        'fetch_url',
        'read_file',
        'read_multiple_files',
        'shell',
        'write_file',
      ])
      const result = await client.callTool({
        name: 'read_file',
        arguments: { path: path.join(root, 'note.txt') },
      })
      expect((result.content as Array<{ text: string }>)[0].text).toBe(
        'hello from a file',
      )
    })
  })

  const exits = (args: string[]) =>
    spawnSync(process.execPath, [entry, ...args], {
      encoding: 'utf-8',
      timeout: 15_000,
    })

  // The line the server writes to stderr when it starts. Stdin is closed at
  // once, so the process ends after printing it.
  const status = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [entry, ...args], {
      encoding: 'utf-8',
      input: '',
      timeout: 15_000,
      env: { ...process.env, BRAVE_API_KEY: '', ...env },
    }).stderr.trim()

  it('says on stderr what it started with', () => {
    expect(status([])).toBe(
      'workshop-mcp running on stdio. File access is not restricted.',
    )
    expect(status([], { BRAVE_API_KEY: 'k' })).toBe(
      'workshop-mcp running on stdio (web search on). File access is not restricted.',
    )
  })

  const packageVersion = (
    JSON.parse(readFileSync('package.json', 'utf-8')) as { version: string }
  ).version

  it('prints the version and exits with --version or -v, without starting', () => {
    for (const flag of ['--version', '-v']) {
      const run = exits([flag])
      expect(run.status, flag).toBe(0)
      expect(run.stdout).toBe(`${packageVersion}\n`)
      expect(run.stderr).toBe('')
    }
  })

  it('prints the options and exits with --help or -h', () => {
    for (const flag of ['--help', '-h']) {
      const run = exits([flag])
      expect(run.status, flag).toBe(0)
      expect(run.stdout).toContain('Usage: workshop-mcp')
      expect(run.stdout).toContain('--allowed-hosts')
      expect(run.stdout).toContain('--version')
      expect(run.stdout).toContain('BRAVE_API_KEY')
      expect(run.stderr).toBe('')
    }
  })

  it('exits with status 1 and the usage for an unknown option', () => {
    const run = exits(['--readonly'])
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('Unknown option')
    expect(run.stderr).toContain('Usage: workshop-mcp')
  })

  // A client config written for an older version must not start the server
  // with more access than its author asked for.
  it.each([
    ['--read-only', 'Unknown option'],
    ['--no-shell', 'Unknown option'],
    ['--no-fetch', 'Unknown option'],
    [path.resolve('.'), 'does not take positional arguments'],
  ])(
    'exits with status 1 for %s, which older versions took',
    (arg, message) => {
      const run = exits([arg])
      expect(run.status).toBe(1)
      expect(run.stderr).toContain(message)
      expect(run.stderr).toContain('Usage: workshop-mcp')
    },
  )
})
