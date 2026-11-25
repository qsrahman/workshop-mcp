import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createServer, type ServerOptions } from '../src/server.js'

// Importing this file gives a test file a fresh temp directory (`dir`, holding
// note.txt) that is also the working directory, so a relative path in a test
// means a file in it, and cleanup of every client connected through it, for
// each test.
export let dir: string
let closers: Array<() => Promise<void>>
let startDirectory: string

beforeEach(async () => {
  dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'fs-mcp-srv-')),
  )
  await fs.writeFile(path.join(dir, 'note.txt'), 'original')
  closers = []
  startDirectory = process.cwd()
  process.chdir(dir)
})

afterEach(async () => {
  for (const close of closers.reverse()) await close()
  process.chdir(startDirectory)
  await fs.rm(dir, { recursive: true, force: true })
})

/** A client connected to a server built with `options`. */
export async function connectTo(
  options: ServerOptions = {},
  // Left out, the client's default applies. 'auto' negotiates the 2026-07-28
  // protocol revision, 'legacy' the 2025 one.
  mode?: 'auto' | 'legacy',
): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  const handle = serveStdio(() => createServer(options), {
    transport: serverTransport,
  })
  const client = new Client(
    { name: 'test', version: '0.0.0' },
    mode ? { versionNegotiation: { mode } } : undefined,
  )
  await client.connect(clientTransport)
  closers.push(
    () => handle.close(),
    () => client.close(),
  )
  return client
}

/** The usual test server: nothing turned on or off. */
export const connect = (mode?: 'auto' | 'legacy') => connectTo({}, mode)

/** Calls a tool and returns whether it failed, with the text of its first block. */
export const callTool = async (
  client: Client,
  name: string,
  args: Record<string, unknown>,
) => {
  const result = await client.callTool({ name, arguments: args })
  return {
    isError: result.isError,
    text: (result.content as Array<{ text: string }>)[0].text,
  }
}

export const callError = async (
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> => {
  const result = await client
    .callTool({ name, arguments: args })
    .catch((error: unknown) => ({
      isError: true,
      content: [{ text: String(error) }],
    }))
  return (result.content as Array<{ text: string }>)[0].text
}

export const names = async (client: Client) =>
  (await client.listTools()).tools.map((t) => t.name).sort()
