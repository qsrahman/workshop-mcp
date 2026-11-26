/**
 * Whether cutting `text` before index `at` would separate the two halves of a
 * surrogate pair (one character outside the Basic Multilingual Plane, such as
 * an emoji). Half a pair is not text: it reaches the model as U+FFFD.
 */
export function splitsPair(text: string, at: number): boolean {
  const before = text.charCodeAt(at - 1)
  const after = text.charCodeAt(at)
  return (
    before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
  )
}

/** `end`, or one less if cutting there would separate a surrogate pair. */
export const wholeEnd = (text: string, end: number): number =>
  splitsPair(text, end) ? end - 1 : end
