// Adapted from modelcontextprotocol/servers (src/filesystem); see THIRD_PARTY_NOTICES.md.
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { applyFileEdits, fileEditSchema } from '../edit.js'
import {
  MAX_MULTI_READ_CHARS,
  friendlyFsError,
  readText,
  tailFile,
  withFileLock,
  writeFileContent,
} from '../files.js'
import { validatePath } from '../paths.js'
import { READ_ANNOTATIONS, text } from './common.js'

const MAX_READ_PATHS = 50

// Annotations for write operations (write_file and edit_file).
const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
}

/** Run `fn`, naming `shown` (the path as the client wrote it) in any fs error. */
async function guard<T>(shown: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw friendlyFsError(error, shown)
  }
}

export function registerFileTools(server: McpServer) {
  const pathParam = z
    .string()
    .describe("Absolute path, or relative to the server's working directory.")

  server.registerTool(
    'read_file',
    {
      title: 'Read File',
      description:
        'Read a text file (not a directory or a binary file). Output is capped at about 100,000 characters; a longer ' +
        'file ends with the offset to continue from. Use offset and limit for a ' +
        'range of lines, head for the first N lines or tail for the last N (use ' +
        'only one of the three).',
      inputSchema: z.strictObject({
        path: pathParam,
        offset: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Line number to start reading from (1-based).'),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Most lines to return, counting from offset.'),
        head: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Return only the first N lines.'),
        tail: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Return only the last N lines.'),
      }),
      annotations: READ_ANNOTATIONS,
    },
    async (args) => {
      const ranged = args.offset !== undefined || args.limit !== undefined
      if (
        [ranged, args.head !== undefined, args.tail !== undefined].filter(
          Boolean,
        ).length > 1
      ) {
        throw new Error(
          'Use only one of head, tail, or offset/limit, not a combination',
        )
      }
      const file = await validatePath(args.path)
      return text(
        await guard(args.path, () =>
          args.tail !== undefined
            ? tailFile(file, args.tail)
            : readText(file, {
                offset: args.offset,
                limit: args.head ?? args.limit,
              }),
        ),
      )
    },
  )

  server.registerTool(
    'read_multiple_files',
    {
      title: 'Read Multiple Files',
      description:
        'Read several files in one call, instead of reading them one at a time; each ' +
        'is returned under its path, and a failed read does not stop the others. Output is capped at about 200,000 characters ' +
        'in total: a file that does not fit is cut, with the offset to continue ' +
        'from when you read it on its own.',
      inputSchema: z.strictObject({
        paths: z
          .array(z.string())
          .min(1)
          .max(MAX_READ_PATHS)
          .describe('Paths of the files to read.'),
      }),
      annotations: READ_ANNOTATIONS,
    },
    async (args) => {
      // One at a time, against a shared character budget, so the response and
      // the memory held while building it stay bounded.
      let remaining = MAX_MULTI_READ_CHARS
      const results: string[] = []
      for (const filePath of args.paths) {
        if (remaining <= 0) {
          results.push(
            `${filePath}: Skipped - the size limit for this call was reached; read it on its own`,
          )
          continue
        }
        try {
          const file = await validatePath(filePath)
          const content = await guard(filePath, () =>
            readText(file, { maxChars: remaining }),
          )
          remaining -= content.length
          results.push(`${filePath}:\n${content}\n`)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          results.push(`${filePath}: Error - ${message}`)
        }
      }
      return text(results.join('\n---\n'))
    },
  )

  server.registerTool(
    'write_file',
    {
      title: 'Write File',
      description:
        'Create a file or completely overwrite one, creating missing parent ' +
        'directories. Overwrites without warning; to change part of a file use ' +
        'the edit tool.',
      inputSchema: z.strictObject({
        path: pathParam,
        content: z
          .string()
          .describe('The complete new contents of the file, written as given.'),
      }),
      annotations: {
        ...WRITE_TOOL_ANNOTATIONS,
        idempotentHint: true,
      },
    },
    async (args) => {
      const file = await validatePath(args.path)
      await guard(args.path, () =>
        withFileLock(file, () => writeFileContent(file, args.content)),
      )
      return text(`Successfully wrote to ${args.path}`)
    },
  )

  server.registerTool(
    'edit_file',
    {
      title: 'Edit File',
      description:
        'Make line-based edits to a text file, applied in order: each replaces ' +
        'oldText with newText. oldText must match exactly one place (add ' +
        'surrounding lines to make it unique) unless replaceAll is set. When ' +
        'there is no exact match, line endings and leading/trailing whitespace ' +
        'on whole lines are ignored. If any edit has no match or an ambiguous ' +
        'one, nothing is written. Returns a git-style diff.',
      inputSchema: z.strictObject({
        path: pathParam,
        edits: z
          .array(fileEditSchema)
          .min(1)
          .describe('The replacements, applied in order.'),
        dryRun: z
          .boolean()
          .default(false)
          .describe(
            'If true, return the diff without changing the file (default false).',
          ),
      }),
      annotations: {
        ...WRITE_TOOL_ANNOTATIONS,
        idempotentHint: false,
      },
    },
    async (args) => {
      const file = await validatePath(args.path)
      return text(
        await guard(args.path, () =>
          withFileLock(file, () =>
            applyFileEdits(file, args.edits, args.dryRun, args.path),
          ),
        ),
      )
    },
  )
}
