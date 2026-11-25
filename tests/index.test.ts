import { describe, expect, it } from 'vitest'
import { parseArgs, resolveConfig } from '../src/index.js'

describe('resolveConfig', () => {
  it('turns web search on only when BRAVE_API_KEY is set and not blank', () => {
    expect(resolveConfig([], {}).brave).toBeUndefined()
    expect(resolveConfig([], { BRAVE_API_KEY: '  ' }).brave).toBeUndefined()
    expect(resolveConfig([], { BRAVE_API_KEY: ' key ' }).brave).toEqual({
      apiKey: 'key',
    })
  })

  it('passes the fetch policy through', () => {
    expect(
      resolveConfig(['--allow-private-ips', '--allowed-hosts', 'a.test'], {})
        .fetch,
    ).toEqual({
      allowPrivateIps: true,
      ignoreRobotsTxt: false,
      allowedHosts: ['a.test'],
    })
  })

  it('passes --help and --version through', () => {
    expect(resolveConfig([], {})).toMatchObject({ help: false, version: false })
    expect(resolveConfig(['-h'], {})).toMatchObject({ help: true })
    expect(resolveConfig(['-v'], {})).toMatchObject({ version: true })
  })

  it('throws on an unknown option', () => {
    expect(() => resolveConfig(['--readonly'], {})).toThrow('Unknown option')
  })
})

describe('parseArgs', () => {
  it('has no required arguments, and nothing turned on that is off by default', () => {
    expect(parseArgs([])).toEqual({
      help: false,
      version: false,
      fetch: { allowPrivateIps: false, ignoreRobotsTxt: false },
    })
  })

  it('asks for the help or the version with --help, -h, --version or -v', () => {
    for (const flag of ['--help', '-h']) {
      expect(parseArgs([flag])).toMatchObject({ help: true, version: false })
    }
    for (const flag of ['--version', '-v']) {
      expect(parseArgs([flag])).toMatchObject({ help: false, version: true })
    }
  })

  it('rejects an unknown option instead of ignoring it', () => {
    expect(() => parseArgs(['--readonly'])).toThrow('Unknown option')
    expect(() => parseArgs(['--read_only'])).toThrow('--read_only')
    expect(() => parseArgs(['-x'])).toThrow('-x')
  })

  // A client config written for an older version must not start the server
  // with more access than its author asked for, so these stop it instead.
  it.each([
    ['--read-only'],
    ['--no-shell'],
    ['--no-fetch'],
    ['--enable-shell'],
    ['--read-only', '--no-shell'],
  ])('no longer knows %s, and says so', (...args) => {
    expect(() => parseArgs(args)).toThrow('Unknown option')
  })

  it('takes no directory, with or without --', () => {
    for (const args of [['/a'], ['/a', '/b'], ['--', '/a'], ['--read-only']]) {
      expect(() => parseArgs(args), args.join(' ')).toThrow()
    }
    expect(() => parseArgs(['/a'])).toThrow('does not take positional')
  })
})

describe('fetch options', () => {
  it('reads the network policy flags', () => {
    expect(
      parseArgs(['--allow-private-ips', '--ignore-robots-txt']).fetch,
    ).toEqual({
      allowPrivateIps: true,
      ignoreRobotsTxt: true,
    })
  })

  it('reads --allowed-hosts as a comma separated list, repeated or not, and normalizes it', () => {
    const hosts = (...args: string[]) => parseArgs(args).fetch.allowedHosts
    expect(hosts('--allowed-hosts', 'Example.com,*.docs.example.org')).toEqual([
      'example.com',
      '*.docs.example.org',
    ])
    expect(
      hosts('--allowed-hosts', 'a.test', '--allowed-hosts', 'b.test'),
    ).toEqual(['a.test', 'b.test'])
    expect(hosts('--allowed-hosts=c.test')).toEqual(['c.test'])
    expect(hosts()).toBeUndefined()
  })

  it('rejects an allowed host that is not a host, rather than ignoring it', () => {
    expect(() => parseArgs(['--allowed-hosts', 'https://example.com'])).toThrow(
      'not a host name',
    )
    expect(() => parseArgs(['--allowed-hosts', 'example.com:8080'])).toThrow(
      'not a host name',
    )
  })

  it('does not take a value for a flag without one', () => {
    expect(() => parseArgs(['--allow-private-ips=yes'])).toThrow()
  })
})
