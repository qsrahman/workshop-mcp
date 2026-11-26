// Property-based tests: invariants that must hold for any input, checked on
// generated ones. A failure prints the seed and the smallest input that fails.
// The `examples` of a test are inputs that once failed it; they always run.
import fs from 'node:fs/promises'
import path from 'node:path'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBrave } from '../src/brave.js'
import { applyFileEdits } from '../src/edit.js'
import { readText, tailFile } from '../src/files.js'
import { parseArgs } from '../src/index.js'
import { runShell } from '../src/shell.js'
import { paginate } from '../src/web.js'
import { makeTempDirs, removeTempDirs, startFakeBrave } from './helpers.js'

let root: string
let outside: string
let files = 0

beforeAll(async () => {
  ;({ root, outside } = await makeTempDirs())
})
afterAll(() => removeTempDirs(root, outside))

const write = async (content: string) => {
  const file = path.join(root, `p${files++}.txt`)
  await fs.writeFile(file, content)
  return file
}

// Any text of one line: ordinary characters, and the ones that some code treats
// as a line break or as special. No "\n" (the generators add those) and no NUL
// (such a file is refused as binary).
const odd = fc.constantFrom(
  '\r',
  '\u2028',
  '\u2029',
  '\u0085',
  '\t',
  '\f',
  '$&',
  '$1',
  '😀',
)
const piece = fc.oneof(
  { weight: 8, arbitrary: fc.string({ unit: 'grapheme', maxLength: 12 }) },
  { weight: 1, arbitrary: odd },
)
const line = fc
  .array(piece, { maxLength: 4 })
  .map((parts) => parts.join('').replace(/[\n\0]/g, ''))
const lfLine = line.map((text) => text.replaceAll('\r', ''))
const content = (lines: fc.Arbitrary<string>) =>
  fc
    .tuple(fc.array(lines, { maxLength: 12 }), fc.boolean())
    .map(([all, final]) => all.join('\n') + (final && all.length ? '\n' : ''))

/** The lines of a text as the file tools describe them: "\n" or "\r\n" ends one. */
const asLines = (text: string) => text.replace(/\r\n/g, '\n').replace(/\n$/, '')

describe('reading', () => {
  it('tail: n returns the last n lines', async () => {
    await fc.assert(
      fc.asyncProperty(
        content(line),
        fc.integer({ min: 1, max: 15 }),
        async (text, n) => {
          const expected = asLines(text).split('\n').slice(-n).join('\n')
          expect(await tailFile(await write(text), n)).toBe(expected)
        },
      ),
    )
  })

  it('pages read with offset add up to the whole file', async () => {
    const more =
      /\n\[\.\.\. showing lines \d+-\d+; more lines follow\. Continue by reading this file with offset=(\d+)\]$/
    await fc.assert(
      fc.asyncProperty(
        content(line),
        fc.integer({ min: 1, max: 5 }),
        async (text, limit) => {
          const file = await write(text)
          const pages: string[] = []
          for (let offset: number | undefined = 1; offset !== undefined;) {
            const page: string = await readText(file, { offset, limit })
            const next = more.exec(page)
            pages.push(next ? page.slice(0, next.index) : page)
            offset = next ? Number(next[1]) : undefined
            expect(pages.length).toBeLessThan(200)
          }
          expect(pages.join('\n')).toBe(asLines(text))
        },
      ),
      { examples: [['a\u2028b', 1]] },
    )
  })

  it('never returns half of a surrogate pair when it cuts a long line', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ unit: 'grapheme', minLength: 5, maxLength: 60 }),
        fc.integer({ min: 1, max: 20 }),
        async (text, maxChars) => {
          const file = await write(text.replace(/[\r\n\0]/g, ''))
          const out = await readText(file, { maxChars })
          expect(out.isWellFormed()).toBe(true)
        },
      ),
      { examples: [['😀😀😀😀😀', 1]] },
    )
  })
})

describe('editing', () => {
  const fragment = lfLine.filter((text) => text !== '')

  it('a dry run never changes the file, whether or not the edit matches', async () => {
    await fc.assert(
      fc.asyncProperty(
        content(line),
        fragment,
        line,
        async (text, oldText, newText) => {
          const file = await write(text)
          const before = await fs.readFile(file)
          await applyFileEdits(file, [{ oldText, newText }], true).catch(
            () => {},
          )
          expect(await fs.readFile(file)).toEqual(before)
        },
      ),
    )
  })

  it('writes nothing when a later edit in the same call fails', async () => {
    await fc.assert(
      fc.asyncProperty(
        content(lfLine).filter((text) => text.trim() !== ''),
        lfLine,
        async (text, newText) => {
          const file = await write(text)
          const before = await fs.readFile(file)
          const first = text.split('\n').find((l) => l.trim() !== '')!
          await expect(
            applyFileEdits(file, [
              { oldText: first, newText, replaceAll: true },
              { oldText: '\u0001 not in any generated file \u0001', newText },
            ]),
          ).rejects.toThrow()
          expect(await fs.readFile(file)).toEqual(before)
        },
      ),
    )
  })

  it('replaces a fragment that occurs once exactly as written, "$" and all', async () => {
    await fc.assert(
      fc.asyncProperty(
        content(lfLine),
        fc.nat(),
        fc.nat(),
        lfLine,
        async (text, a, b, newText) => {
          const chars = [...text]
          fc.pre(chars.length > 0)
          const start = a % chars.length
          const end = start + 1 + (b % (chars.length - start))
          const oldText = chars.slice(start, end).join('')
          fc.pre(text.split(oldText).length === 2)
          const file = await write(text)
          await applyFileEdits(file, [{ oldText, newText }])
          expect(await fs.readFile(file, 'utf-8')).toBe(
            text.replace(oldText, () => newText),
          )
        },
      ),
    )
  })

  it('keeps CRLF line endings, with oldText written with LF', async () => {
    const word = fc.stringMatching(/^[a-z]{1,8}$/)
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(word, { minLength: 2, maxLength: 8 }),
        fc.nat(),
        word,
        async (words, pick, added) => {
          const lines = words.map((w, i) => `${i}:${w};`)
          const file = await write(lines.join('\r\n') + '\r\n')
          const target = lines[pick % lines.length]
          await applyFileEdits(file, [
            { oldText: target, newText: `${target}\n${added}` },
          ])
          const out = await fs.readFile(file, 'utf-8')
          expect(out.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/)
        },
      ),
    )
  })
})

describe('paging a fetched page', () => {
  const more =
    /\n\n\[\.\.\. showing characters \d+-\d+ of \d+; more follows\. Continue with start_index=(\d+)\]$/
  const slices = (text: string, maxLength: number) => {
    const page = { url: 'u', requested: 'u', text, prefix: '' }
    const head = 'Contents of u:\n'
    const parts: string[] = []
    for (let start: number | undefined = 0; start !== undefined;) {
      const out: string = paginate(page, start, maxLength)
      const next = more.exec(out)
      parts.push(out.slice(head.length, next ? next.index : undefined))
      start = next ? Number(next[1]) : undefined
    }
    return parts
  }
  const text = fc.string({ unit: 'grapheme', minLength: 1, maxLength: 60 })
  const size = fc.integer({ min: 1, max: 20 })

  it('slices add up to the whole text', () => {
    fc.assert(
      fc.property(text, size, (t, n) => {
        expect(slices(t, n).join('')).toBe(t)
      }),
    )
  })

  it('returns whole characters from any start_index', () => {
    fc.assert(
      fc.property(text, size, fc.nat(), (t, n, at) => {
        const page = { url: 'u', requested: 'u', text: t, prefix: '' }
        expect(paginate(page, at % t.length, n).isWellFormed()).toBe(true)
      }),
      { examples: [['😀', 5, 1]] },
    )
  })

  it('never returns half of a surrogate pair', () => {
    fc.assert(
      fc.property(text, size, (t, n) => {
        for (const part of slices(t, n)) expect(part.isWellFormed()).toBe(true)
      }),
      { examples: [['😀', 1]] },
    )
  })
})

// Every other place that shortens text for the model. `shift` ordinary
// characters in front of a run of emoji (two UTF-16 units each) put each cut
// inside a character for some of the values.
describe('cutting text', () => {
  const emoji = (count: number) => '😀'.repeat(count)
  const shift = fc.integer({ min: 0, max: 3 })
  /** No half character, raw or written out by JSON.stringify as "\\udxxx". */
  const expectWhole = (text: string) => {
    expect(text.isWellFormed()).toBe(true)
    expect(text).not.toMatch(/\\ud[89a-f]/i)
  }

  it('tail: keeps whole characters when the size limit cuts it', async () => {
    await fc.assert(
      fc.asyncProperty(
        shift,
        fc.integer({ min: 1, max: 30 }),
        async (n, max) => {
          const file = await write(`${'x'.repeat(n)}${emoji(40)}\n`)
          expectWhole(await tailFile(file, 1, max))
        },
      ),
      { examples: [[0, 3]] },
    )
  })

  it('shell: keeps whole characters at both ends of cut output', async () => {
    await fc.assert(
      fc.asyncProperty(shift, shift, async (head, tail) => {
        const script = `process.stdout.write('x'.repeat(${head}) + '😀'.repeat(15000) + 'y'.repeat(${tail}))`
        const result = await runShell(`node -e "${script}"`, root)
        expect(result.stdout).toContain('characters omitted')
        expectWhole(result.stdout)
      }),
      { examples: [[1, 1]], numRuns: 6 },
    )
  })

  it('edit_file: quotes whole characters in a mismatch error', async () => {
    await fc.assert(
      fc.asyncProperty(shift, async (n) => {
        const line = `${'x'.repeat(n)}${emoji(400)}`
        const file = await write(`${line} end\n`)
        const message = await applyFileEdits(file, [
          { oldText: `${line} not there`, newText: 'y' },
        ]).then(
          () => 'no error',
          (error: Error) => error.message,
        )
        expect(message).toContain('cut: the line has')
        // oldText is repeated in full; what follows it is quoted from the file
        expectWhole(message.slice(message.indexOf('Closest text')))
      }),
      { examples: [[1]] },
    )
  })

  it('web_search: clips titles and descriptions between characters', async () => {
    const fake = await startFakeBrave()
    try {
      const brave = createBrave({ apiKey: 'unused-key', baseUrl: fake.baseUrl })
      await fc.assert(
        fc.asyncProperty(shift, async (n) => {
          const long = `${'x'.repeat(n)}${emoji(400)}`
          fake.replies.push({
            body: {
              web: { results: [{ title: long, description: long, url: 'u' }] },
            },
          })
          expectWhole(await brave.web({ query: 'x' }))
        }),
        { examples: [[0], [1]] },
      )
    } finally {
      await fake.close()
    }
  })
})

describe('the Brave API key', () => {
  let fake: Awaited<ReturnType<typeof startFakeBrave>>
  beforeAll(async () => {
    fake = await startFakeBrave()
  })
  afterAll(() => fake.close())

  /** What the model would see: the results, or the error message. */
  const search = (apiKey: string) =>
    createBrave({ apiKey, baseUrl: fake.baseUrl })
      .web({ query: 'x' })
      .catch((error: Error) => error.message)

  /** No stretch of 8 characters of the key appears in `seen`. */
  const expectNoPartOf = (key: string, seen: string) => {
    for (let i = 0; i + 8 <= key.length; i++) {
      expect(seen).not.toContain(key.slice(i, i + 8))
    }
  }
  const realKey = fc.stringMatching(/^Q[A-Z0-9]{23,31}$/)
  const sampleKey = 'QABCDEFGHIJKLMNOPQRSTUVWXYZ012'
  const padding = fc.integer({ min: 0, max: 700 }).map((n) => '.'.repeat(n))

  it('is not shown when Brave echoes it in an error, wherever in the text', async () => {
    await fc.assert(
      fc.asyncProperty(
        realKey,
        padding,
        fc.constantFrom(401, 422, 500),
        async (key, pad, status) => {
          fake.replies.push({
            status,
            body: { error: { detail: pad + key } },
          })
          expectNoPartOf(key, await search(key))
        },
      ),
      { examples: [[sampleKey, '.'.repeat(280), 401]] },
    )
  })

  it('is not shown when Brave echoes it in a result, wherever in the text', async () => {
    await fc.assert(
      fc.asyncProperty(realKey, padding, async (key, pad) => {
        fake.replies.push({
          body: {
            web: {
              results: [{ title: pad + key, description: pad + key, url: 'u' }],
            },
          },
        })
        expectNoPartOf(key, await search(key))
      }),
      { examples: [[sampleKey, '.'.repeat(185)]] },
    )
  })

  it('is not shown for a key that cannot even be sent', async () => {
    const unsendable = fc
      .tuple(realKey, fc.constantFrom('\n', '\r', '\0', '€', '😀'), realKey)
      .map((parts) => parts.join(''))
    await fc.assert(
      fc.asyncProperty(unsendable, async (key) => {
        expectNoPartOf(key, await search(key))
      }),
    )
  })
})

describe('command line options', () => {
  const valid = fc.constantFrom(
    '--allow-private-ips',
    '--ignore-robots-txt',
    '--allowed-hosts=a.test',
    '-h',
    '-v',
  )
  const known =
    /^--(allow-private-ips|ignore-robots-txt|allowed-hosts|help|version)(=|$)/
  const bad = fc.oneof(
    fc.constantFrom('--read-only', '--no-shell', '--no-fetch'),
    fc.stringMatching(/^--[a-z][a-z-]{0,15}$/).filter((a) => !known.test(a)),
    fc.string({ minLength: 1 }).filter((a) => !a.startsWith('-')),
  )

  it('never start the server with a removed or unknown option, or a stray argument', () => {
    fc.assert(
      fc.property(fc.array(valid), bad, fc.nat(), (args, wrong, at) => {
        const argv: string[] = [...args]
        argv.splice(at % (args.length + 1), 0, wrong)
        expect(() => parseArgs(argv)).toThrow()
      }),
    )
  })
})
