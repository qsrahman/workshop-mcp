// Adapted from modelcontextprotocol/servers (src/filesystem) and changed; see
// THIRD_PARTY_NOTICES.md for its licence.
// Reads and writes of single files. Callers pass paths from validatePath.
import fs, { type FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'

// File reading constants.
const TAIL_CHUNK_BYTES = 64 * 1024
const READ_CHUNK_BYTES = 64 * 1024
// How much of a file is checked before it is read. Reading is lossy and
// harmless, so a stray invalid byte later on is not a reason to refuse a file.
const BINARY_SNIFF_BYTES = 8192
const LF_BYTE = 0x0a // counted to find the last lines of a file

// How much text one read returns. This protects the model's context window,
// not memory: 100,000 characters is about 25k tokens. Longer output is cut at
// a line boundary and says where to continue.
const MAX_READ_CHARS = 100_000
// The same, for all files of one read_multiple_files call together.
export const MAX_MULTI_READ_CHARS = 200_000

export const normalizeLineEndings = (text: string) =>
  text.replace(/\r\n/g, '\n')

// Friendly error messages for common file system error codes.
const ERROR_MESSAGES: Record<string, (shown: string) => string> = {
  ENOENT: (shown) => `File not found: ${shown}`,
  EISDIR: (shown) => `${shown} is a directory, not a file`,
  ENOTDIR: (shown) => `A parent of ${shown} is not a directory`,
  EACCES: (shown) => `Permission denied: ${shown}`,
  EPERM: (shown) => `Permission denied: ${shown}`,
  ELOOP: (shown) => `Refusing to read a symbolic link: ${shown}`,
  ENOTFILE: (shown) =>
    `Refusing to read: ${shown} is not a regular file (it is a device, pipe or socket)`,
  ENOTREG: (shown) => `Refusing to write: ${shown} is not a regular file`,
  EBINARY: (shown) =>
    `${shown} looks like a binary file or is not valid UTF-8 text`,
}

/** An error carrying a Node-style `code`, which friendlyFsError understands. */
function codedError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * Rewrite a low-level fs error into one an agent can act on, naming the path as
 * the caller spelled it. Errors without a known code (such as the broken-symlink
 * error from validatePath) pass through unchanged.
 */
export function friendlyFsError(error: unknown, shown: string): Error {
  const builder = ERROR_MESSAGES[(error as NodeJS.ErrnoException)?.code ?? '']
  return builder
    ? new Error(builder(shown), { cause: error })
    : (error as Error)
}

/**
 * Open a file once for reading, refusing a directory (EISDIR), anything else
 * that is not a regular file (ENOTFILE: a device would be read without end, as
 * /dev/zero reports size 0), a symlink swapped in after path validation (ELOOP)
 * and a file that does not look like UTF-8 text (EBINARY): the first
 * `checkBytes` bytes must hold no NUL and be valid UTF-8. The caller reads
 * through the same handle, so the file checked is the file read, and closes it.
 */
async function openTextFile(
  filePath: string,
  checkBytes = BINARY_SNIFF_BYTES,
): Promise<{ handle: FileHandle; size: number }> {
  // O_NONBLOCK: opening a pipe with no writer would otherwise wait for one,
  // for ever. It changes nothing for a regular file, the only kind read below.
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = constants
  let handle: FileHandle
  try {
    handle = await fs.open(filePath, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw codedError('ELOOP')
    }
    throw error
  }
  try {
    const stats = await handle.stat()
    // Named here, before any read: reading a directory fails with a less helpful error.
    if (stats.isDirectory()) throw codedError('EISDIR')
    if (!stats.isFile()) throw codedError('ENOTFILE')
    // A start cut off mid-file may end inside a multi-byte character; the
    // decoder in streaming mode treats that as incomplete, not invalid. Only a
    // check that reaches the end of the file may call a truncated one invalid.
    const end = Math.min(checkBytes, stats.size)
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, end))
    for (let position = 0; position < end;) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, end - position),
        position, // positional: the file offset stays at 0
      )
      if (bytesRead === 0) break
      const part = chunk.subarray(0, bytesRead)
      position += bytesRead
      try {
        if (part.includes(0)) throw new Error('NUL byte')
        decoder.decode(part, { stream: true })
        if (position >= stats.size) decoder.decode()
      } catch {
        throw codedError('EBINARY', 'binary file or not valid UTF-8 text')
      }
    }
    return { handle, size: stats.size }
  } catch (error) {
    await handle.close()
    throw error
  }
}

/**
 * Read a whole text file for editing. Unlike `readText` it refuses invalid
 * UTF-8 anywhere in the file, because the text is written back and decoding
 * would turn those bytes into U+FFFD for good.
 */
export async function readWholeTextFile(filePath: string): Promise<string> {
  const { handle } = await openTextFile(filePath, Infinity)
  try {
    return await handle.readFile('utf-8')
  } finally {
    await handle.close()
  }
}

interface ReadOptions {
  /** Line to start from, 1-based. */
  offset?: number
  /** Most lines to return. */
  limit?: number
  /** Most characters to return. */
  maxChars?: number
}

/**
 * Read lines from a file handle using readline, collecting them with a character budget.
 * Returns collected lines and the next offset if more lines remain.
 */
async function readLinesFromHandle(
  handle: FileHandle,
  startLine: number,
  limitLines: number,
  maxChars: number,
): Promise<{ lines: string[]; nextOffset?: number; totalLines: number }> {
  const input = handle.createReadStream({ encoding: 'utf-8' })
  const rl = createInterface({ input, crlfDelay: Infinity })
  const lines: string[] = []
  let chars = 0
  let lineNumber = 0
  let nextOffset: number | undefined
  try {
    for await (const line of rl) {
      lineNumber++
      if (lineNumber < startLine) continue
      if (
        lines.length >= limitLines ||
        (lines.length > 0 && chars + line.length + 1 > maxChars)
      ) {
        nextOffset = lineNumber
        break
      }
      // A single line longer than the whole budget is cut, not skipped.
      const shown =
        line.length <= maxChars
          ? line
          : `${line.slice(0, maxChars)} [... line cut: it has ${line.length} characters]`
      lines.push(shown)
      chars += shown.length + 1
    }
  } finally {
    rl.close()
    // rl.close() leaves the stream open on an early exit; destroying it
    // stops the pending read before the handle is closed below.
    input.destroy()
  }
  return { lines, nextOffset, totalLines: lineNumber }
}

/**
 * Read a text file, or a range of its lines. A file that fits within maxChars
 * is returned byte for byte; anything else is read line by line (line endings
 * become LF) and stops at `limit` lines or `maxChars` characters, whichever
 * comes first. When lines remain, the text ends with a note giving the offset
 * to continue from.
 */
export async function readText(
  filePath: string,
  { offset = 1, limit = Infinity, maxChars = MAX_READ_CHARS }: ReadOptions = {},
): Promise<string> {
  const { handle, size } = await openTextFile(filePath)
  try {
    if (offset === 1 && limit === Infinity && size <= maxChars) {
      return await handle.readFile('utf-8')
    }

    const { lines, nextOffset, totalLines } = await readLinesFromHandle(
      handle,
      offset,
      limit,
      maxChars,
    )

    if (lines.length === 0 && nextOffset === undefined && offset > 1) {
      return `[offset ${offset} is past the end of the file, which has ${totalLines} lines]`
    }
    const text = lines.join('\n')
    return nextOffset === undefined
      ? text
      : `${text}\n[... showing lines ${offset}-${nextOffset - 1}; more lines follow. Continue by reading this file with offset=${nextOffset}]`
  } finally {
    await handle.close()
  }
}

/** The last `n` lines of a file (line endings become LF), capped at maxChars. */
export async function tailFile(
  filePath: string,
  n: number,
  maxChars = MAX_READ_CHARS,
): Promise<string> {
  if (n === 0) return '' // slice(-0) would return every line
  const { handle, size } = await openTextFile(filePath)
  try {
    // Read backwards in chunks until n + 1 newlines are in hand (n lines plus
    // the break before the first of them; a final newline ends a line, so it
    // is not one of the n), or until more bytes than the cap could use.
    let position = size
    const chunks: Buffer[] = []
    let newlines = 0
    let bytes = 0
    while (position > 0 && newlines <= n && bytes < maxChars * 4) {
      const length = Math.min(TAIL_CHUNK_BYTES, position)
      position -= length
      const chunk = Buffer.alloc(length)
      await handle.read(chunk, 0, length, position)
      chunks.unshift(chunk)
      bytes += length
      for (const byte of chunk) if (byte === LF_BYTE) newlines++
    }
    const text = normalizeLineEndings(
      Buffer.concat(chunks).toString('utf-8'),
    ).replace(/\n$/, '')
    const lines = text === '' ? [] : text.split('\n')
    // Unless the start of the file was reached, the first line is partial. It
    // needs no special handling: when enough lines were read, the last n leave
    // it out, and when the byte limit stopped the read first, a cut line is
    // all there is, and the cap below says so.
    const result = lines.slice(-n).join('\n')
    return result.length > maxChars
      ? `[... showing only the last ${maxChars} characters ...]\n${result.slice(-maxChars)}`
      : result
  } finally {
    await handle.close()
  }
}

const queues = new Map<string, Promise<unknown>>()

/**
 * Run `fn` after every earlier call with the same key has finished, so two
 * read-modify-write operations on one file cannot overlap and lose an update.
 * Key on the path validatePath returned, which is the file's real path.
 */
export async function withFileLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn)
  // The stored tail never rejects, so one failure does not block later calls.
  const tail = run.catch(() => {})
  queues.set(key, tail)
  try {
    return await run
  } finally {
    if (queues.get(key) === tail) queues.delete(key)
  }
}

/**
 * Create or overwrite a file, creating any missing parent directories.
 * Exclusive creation never writes through a symlink; an existing entry must be
 * a regular file, opened with O_NOFOLLOW. The directories are made below the
 * nearest existing ancestor that validatePath resolved.
 */
export async function writeFileContent(
  filePath: string,
  content: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  try {
    await fs.writeFile(filePath, content, { encoding: 'utf-8', flag: 'wx' })
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  if (!(await fs.lstat(filePath)).isFile()) {
    throw codedError('ENOTREG', 'not a regular file')
  }
  // Overwrite in place (not rename) to keep the inode, permissions and links.
  const { O_WRONLY, O_TRUNC, O_NOFOLLOW = 0 } = constants
  const handle = await fs.open(filePath, O_WRONLY | O_TRUNC | O_NOFOLLOW)
  try {
    await handle.writeFile(content, 'utf-8')
  } finally {
    await handle.close()
  }
}
