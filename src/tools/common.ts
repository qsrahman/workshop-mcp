export const text = (content: string) => ({
  content: [{ type: 'text' as const, text: content }],
})

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
