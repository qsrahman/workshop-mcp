#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs as parseNodeArgs } from 'node:util'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { normalizeAllowedHost } from './net.js'
import { createServer, version } from './server.js'

export function parseArgs(args: string[]) {
  // strict makes an unknown option throw instead of being ignored, and no
  // positional argument is allowed: a client config written for an older
  // version (with --read-only, --no-shell or a directory) must not start the
  // server with more access than its author asked for.
  const { values } = parseNodeArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      'allow-private-ips': { type: 'boolean', default: false },
      'ignore-robots-txt': { type: 'boolean', default: false },
      'allowed-hosts': { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  })
  const allowedHosts = (values['allowed-hosts'] ?? [])
    .flatMap((list) => list.split(','))
    .filter((entry) => entry.trim() !== '')
    .map(normalizeAllowedHost)
  return {
    help: values.help,
    version: values.version,
    fetch: {
      allowPrivateIps: values['allow-private-ips'],
      ignoreRobotsTxt: values['ignore-robots-txt'],
      allowedHosts: allowedHosts.length > 0 ? allowedHosts : undefined,
    },
  }
}

const USAGE =
  'Usage: workshop-mcp [--allow-private-ips] [--ignore-robots-txt]\n' +
  '                     [--allowed-hosts a.com,*.b.org]'

const HELP = `${USAGE}

Options:
  --allow-private-ips  let fetch_url reach private and local addresses
  --ignore-robots-txt  do not consult robots.txt before fetching a page
  --allowed-hosts      limit fetch_url to these hosts (comma separated, or
                       repeat the option; *.domain matches subdomains)
  -h, --help           show this help
  -v, --version        show the version

The server is not restricted to any directory and always serves the file
tools, the shell and fetch_url. BRAVE_API_KEY in the environment turns on the
brave_web_search tool.`

/**
 * Everything the server is started with, from the command line and the
 * environment. Throws, with a message fit to print, when the arguments are
 * unusable; `main` turns that into exit code 1.
 */
export function resolveConfig(argv: string[], env: NodeJS.ProcessEnv) {
  const { fetch } = parseArgs(argv)
  // The key comes from the environment, not an option, so it never shows up in
  // a process listing. Without one, the web search tool is not offered.
  const apiKey = env.BRAVE_API_KEY?.trim()
  return { fetch, brave: apiKey ? { apiKey } : undefined }
}

function main() {
  const argv = process.argv.slice(2)
  let config: ReturnType<typeof resolveConfig>
  try {
    // Answered before anything is served. This is the one place that writes to
    // stdout, which is otherwise the protocol.
    const asked = parseArgs(argv)
    if (asked.help) {
      process.stdout.write(`${HELP}\n`)
      return
    }
    if (asked.version) {
      process.stdout.write(`${version}\n`)
      return
    }
    config = resolveConfig(argv, process.env)
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`)
    process.exit(1)
  }

  serveStdio(() => createServer(config), {
    onerror: (error) => {
      console.error('Transport error:', error)
      process.exitCode = 1
    },
  })
  console.error(
    `workshop-mcp running on stdio${config.brave ? ' (web search on)' : ''}. File access is not restricted.`,
  )
}

// Run only as the entry point (npm links the bin via a symlink, hence realpath),
// so importing this module, as the tests do, starts nothing.
const entry = process.argv[1]
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error('Fatal error running server:', error)
    process.exit(1)
  }
}
