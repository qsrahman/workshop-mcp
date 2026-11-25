import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FS_CALL_TIMEOUT_MS,
  validatePath,
  withFsTimeout,
} from '../src/paths.js'
import { makeTempDirs, removeTempDirs } from './helpers.js'

let root: string
let outside: string

beforeEach(async () => ({ root, outside } = await makeTempDirs()))
afterEach(() => removeTempDirs(root, outside))

describe('validatePath', () => {
  it('accepts a file, and a new file with an existing parent', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'x')
    expect(await validatePath(path.join(root, 'a.txt'))).toBe(
      path.join(root, 'a.txt'),
    )
    expect(await validatePath(path.join(root, 'new.txt'))).toBe(
      path.join(root, 'new.txt'),
    )
  })

  it('accepts a path several levels below the last existing directory', async () => {
    expect(await validatePath(path.join(root, 'no/such/dir/f.txt'))).toBe(
      path.join(root, 'no/such/dir/f.txt'),
    )
  })

  it('accepts any path, including one that leaves through ..', async () => {
    expect(
      await validatePath(path.join(root, '..', path.basename(outside))),
    ).toBe(outside)
    expect(await validatePath(path.join(outside, 'new', 'deep.txt'))).toBe(
      path.join(outside, 'new', 'deep.txt'),
    )
  })

  it('resolves a symlink to the file it points to, wherever that is', async () => {
    await fs.writeFile(path.join(outside, 's'), 'secret')
    await fs.symlink(path.join(outside, 's'), path.join(root, 'link'))
    expect(await validatePath(path.join(root, 'link'))).toBe(
      path.join(outside, 's'),
    )
  })

  it('resolves the existing part of a new path through symlinks', async () => {
    await fs.mkdir(path.join(root, 'real'))
    await fs.symlink(path.join(root, 'real'), path.join(root, 'alias'))
    expect(await validatePath(path.join(root, 'alias', 'a', 'b.txt'))).toBe(
      path.join(root, 'real', 'a', 'b.txt'),
    )
    await fs.symlink(outside, path.join(root, 'out'))
    expect(await validatePath(path.join(root, 'out', 'a', 'b.txt'))).toBe(
      path.join(outside, 'a', 'b.txt'),
    )
  })

  it('resolves a relative path against the working directory', async () => {
    expect(await validatePath('package.json')).toBe(
      path.join(await fs.realpath(process.cwd()), 'package.json'),
    )
  })

  it('expands ~ to the home directory', async () => {
    const home = await fs.realpath(os.homedir())
    expect(await validatePath('~/no-such-file-xyz')).toBe(
      path.join(home, 'no-such-file-xyz'),
    )
    expect(await validatePath('~')).toBe(home)
  })

  it('rejects a NUL byte', async () => {
    await expect(validatePath(path.join(root, 'a\0b'))).rejects.toThrow(
      'Invalid path',
    )
  })

  it('names a broken symlink, also in the middle of a path', async () => {
    await fs.symlink(
      path.join(root, 'missing-target'),
      path.join(root, 'dangling'),
    )
    await expect(validatePath(path.join(root, 'dangling'))).rejects.toThrow(
      'Broken symlink',
    )
    await expect(
      validatePath(path.join(root, 'dangling', 'sub', 'f.txt')),
    ).rejects.toThrow('Broken symlink')
  })
})

describe('filesystem call timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('rejects a call that never settles, naming the operation and path', async () => {
    await expect(
      withFsTimeout(new Promise(() => {}), 'realpath', '/cloud/x', 20),
    ).rejects.toThrow(
      /timed out after 20 ms: realpath \/cloud\/x.*cloud-storage/,
    )
  })

  it('passes through a value, and a rejection, that arrives in time', async () => {
    expect(await withFsTimeout(Promise.resolve('ok'), 'stat', '/x', 1000)).toBe(
      'ok',
    )
    await expect(
      withFsTimeout(Promise.reject(new Error('boom')), 'stat', '/x', 1000),
    ).rejects.toThrow('boom')
  })

  it('leaves no timer behind once the call settles', async () => {
    vi.useFakeTimers()
    await withFsTimeout(Promise.resolve(1), 'stat', '/x', 1000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('makes validatePath fail with a timeout when realpath hangs', async () => {
    vi.useFakeTimers()
    vi.spyOn(fs, 'realpath').mockReturnValue(new Promise(() => {}) as never)
    const outcome = validatePath(path.join(root, 'stuck.txt')).then(
      () => 'resolved',
      (error: Error) => error.message,
    )
    await vi.advanceTimersByTimeAsync(FS_CALL_TIMEOUT_MS)
    expect(await outcome).toContain('timed out after 15000 ms: realpath')
  })

  it('makes validatePath fail with a timeout when lstat hangs', async () => {
    vi.useFakeTimers()
    vi.spyOn(fs, 'realpath').mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    )
    vi.spyOn(fs, 'lstat').mockReturnValue(new Promise(() => {}) as never)
    const outcome = validatePath(path.join(root, 'stuck.txt')).then(
      () => 'resolved',
      (error: Error) => error.message,
    )
    await vi.advanceTimersByTimeAsync(FS_CALL_TIMEOUT_MS)
    expect(await outcome).toContain(
      `timed out after ${FS_CALL_TIMEOUT_MS} ms: lstat`,
    )
  })
})
