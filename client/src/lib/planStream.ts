// A plan as it streams, readable before it is parsed.
//
// The planner writes `<<<PLAN section="tools">>> … <<<ENDPLAN>>>` delimiters, which is right for the
// parser and wrong for a person: the card showed them verbatim for the whole of the stream, so the
// first thing anybody saw of their plan was protocol. The settled card renders the parsed structure;
// this is only what the caret is moving through until then.

/** The streamed text with each section opened as a heading, closings gone, and a marker still
 *  arriving held back rather than flashed half-written. */
export function readablePlanStream(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/<<<PLAN\s+section="([^"]*)"\s*>>>[ \t]*\n?/g, (_m, section: string) => `${section.toUpperCase()}\n`)
    .replace(/[ \t]*<<<ENDPLAN>>>[ \t]*\n?/g, "\n")
    // A delimiter whose first characters have arrived and whose last have not.
    .replace(/(?:<{1,2}|<<<[A-Z]*(?:\s[^\n<>]*)?>{0,2})$/, "")
    .replace(/\n{3,}/g, "\n\n");
}
