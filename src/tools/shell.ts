import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { validatePath } from '../paths.js'
import { DEFAULT_COMMAND_TIMEOUT_MS, formatResult, runShell } from '../shell.js'
import { guard, text } from './common.js'

// The largest timeout execa accepts (a 32-bit setTimeout delay, about 24.8 days).
const MAX_TIMEOUT_MS = 2_147_483_647

export function registerShellTool(server: McpServer) {
  server.registerTool(
    'shell',
    {
      title: 'Shell',
      description:
        'Run a shell command and return its output; a failed command starts with ' +
        'its exit code, and stderr is labelled when there is any. Use it for tests, ' +
        'type checks, builds, git, and to list and search files (ls, find, grep). ' +
        'Do NOT use it to read, write or edit files (use the file tools), for ' +
        'interactive commands (stdin is closed), for commands that never exit (dev ' +
        'servers, watch modes), or for destructive ones (rm -rf, git reset --hard, ' +
        'force pushes) unless the user asked. Each call is a fresh process, so cd ' +
        "does not persist: use cwd (default: the server's working directory). The " +
        'command and its child processes are killed after timeoutMs. Output past ' +
        '20000 characters keeps its start and end; binary output becomes a short ' +
        'note.',
      inputSchema: z.strictObject({
        command: z
          .string()
          .min(1)
          .describe(
            "The command to run, for example 'ls -lh' or 'git status'.",
          ),
        cwd: z
          .string()
          .optional()
          .describe(
            "Directory to run the command in. Defaults to the server's working directory.",
          ),
        timeoutMs: z
          .int()
          .min(0)
          .max(MAX_TIMEOUT_MS)
          .optional()
          .describe(
            `Kill the command after this many milliseconds (at most ${MAX_TIMEOUT_MS}). Defaults to ${DEFAULT_COMMAND_TIMEOUT_MS}; 0 disables the timeout.`,
          ),
      }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (args, ctx) => {
      const shown = args.cwd
      const cwd = shown
        ? await guard(shown, () => validatePath(shown))
        : process.cwd()
      const result = await runShell(
        args.command,
        cwd,
        args.timeoutMs,
        ctx.mcpReq.signal,
      )
      // a non-zero exit is still a result; flag it so clients can see it failed
      return { ...text(formatResult(result)), isError: !result.ok }
    },
  )
}
