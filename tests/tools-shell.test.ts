import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Client } from '@modelcontextprotocol/client'
import { connect, dir, names } from './harness.js'

describe('shell tool', () => {
  const callShell = async (client: Client, args: Record<string, unknown>) => {
    const result = await client.callTool({ name: 'shell', arguments: args })
    const block = (result.content as Array<{ type: string; text: string }>)[0]
    return { isError: result.isError, text: block.text }
  }

  it('is always served', async () => {
    expect(await names(await connect())).toContain('shell')
  })

  it('runs in the working directory by default', async () => {
    const client = await connect()
    const { isError, text } = await callShell(client, { command: 'pwd' })
    expect(isError).toBeFalsy()
    expect(await fs.realpath(text)).toBe(dir)
  })

  it('flags a failing command with isError and keeps the result', async () => {
    const client = await connect()
    const { isError, text } = await callShell(client, { command: 'exit 3' })
    expect(isError).toBe(true)
    expect(text).toBe('exit code 3')
  })

  it('rejects a timeoutMs execa cannot honour, naming the parameter', async () => {
    const client = await connect()
    const { isError, text } = await callShell(client, {
      command: 'pwd',
      timeoutMs: 3_000_000_000,
    })
    expect(isError).toBe(true)
    expect(text).toContain('timeoutMs')
    expect(
      (await callShell(client, { command: 'pwd', timeoutMs: 2_147_483_647 }))
        .isError,
    ).toBeFalsy()
  })

  it('runs in any directory it is given a cwd for, and says when there is none', async () => {
    await fs.mkdir(path.join(dir, 'sub'))
    const client = await connect()
    const sub = await callShell(client, { command: 'pwd', cwd: 'sub' })
    expect(sub.text).toMatch(/sub$/)
    expect((await callShell(client, { command: 'pwd', cwd: '/' })).text).toBe(
      '/',
    )
    const missing = await callShell(client, {
      command: 'pwd',
      cwd: path.join(dir, 'no-such-dir'),
    })
    expect(missing.isError).toBe(true)
  })
})
