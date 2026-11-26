import { friendlyFsError } from '../files.js'

export const text = (content: string) => ({
  content: [{ type: 'text' as const, text: content }],
})

/** Run `fn`, naming `shown` (the path as the client wrote it) in any fs error. */
export async function guard<T>(
  shown: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw friendlyFsError(error, shown)
  }
}

/** For tools that only read local state. */
export const READ_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
}

/**
 * For tools that only read from the internet. They change nothing locally, but
 * they do reach out (openWorldHint).
 */
export const WEB_ANNOTATIONS = { ...READ_ANNOTATIONS, openWorldHint: true }
