// Adapted from modelcontextprotocol/servers (src/filesystem) and changed; see
// THIRD_PARTY_NOTICES.md for its licence.
// Path validation: every tool resolves its path through validatePath.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// A filesystem call on a cloud-storage or network provider can hang while the
// provider fetches the entry. Without a bound, the agent's request hangs with
// it. A timeout only stops waiting: Node cannot cancel an fs call in flight, so
// the stalled call keeps one of libuv's threadpool threads (4 by default) until
// the provider answers.
export const FS_CALL_TIMEOUT_MS = 15_000

/** A filesystem call that did not settle within the timeout. */
class FsTimeoutError extends Error {
  constructor(operation: string, target: string, ms: number) {
    super(
      `Filesystem call timed out after ${ms} ms: ${operation} ${target}. ` +
        'The path may be on a cloud-storage or network drive that fetches it on demand; ' +
        'try again later or use another path.',
    )
    this.name = 'FsTimeoutError'
  }
}

/** Race `call` against a timer; the losing call is not cancelled (see above). */
export async function withFsTimeout<T>(
  call: Promise<T>,
  operation: string,
  target: string,
  ms: number = FS_CALL_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new FsTimeoutError(operation, target, ms)),
      ms,
    )
  })
  try {
    return await Promise.race([call, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve `requested` to a real path, or throw. Symlinks are resolved first, so
 * the file tools act on the file a link points to, and relative paths resolve
 * against the working directory. A path that does not exist yet is accepted:
 * the result is its nearest existing ancestor's real path plus the missing
 * names, so a caller can create the missing directories. Nothing is restricted:
 * the server can reach whatever the user running it can.
 */
export async function validatePath(requested: string): Promise<string> {
  if (requested.includes('\0'))
    throw new Error('Invalid path: it contains a NUL character')
  const expanded =
    requested === '~' || requested.startsWith('~/')
      ? path.join(os.homedir(), requested.slice(1))
      : requested
  const absolute = path.resolve(process.cwd(), expanded)

  // Walk up to the nearest ancestor that exists.
  const missing: string[] = []
  let existing = absolute
  let real: string
  for (;;) {
    try {
      real = await withFsTimeout(fs.realpath(existing), 'realpath', existing)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    // ENOENT also means a symlink whose target is missing; name it now rather
    // than fail later with a confusing error.
    const stats = await withFsTimeout(
      fs.lstat(existing),
      'lstat',
      existing,
    ).catch((error: unknown) => {
      if (error instanceof FsTimeoutError) throw error
      return null
    })
    if (stats?.isSymbolicLink()) {
      throw new Error(`Broken symlink (its target does not exist): ${existing}`)
    }
    missing.unshift(path.basename(existing))
    existing = path.dirname(existing)
  }

  return path.join(real, ...missing)
}
