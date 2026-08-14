// Finding where a credential is used, by reading the agent's own source.
//
// HALF OF AN ANSWER, AND IT SAYS SO. A static scan misses a name assembled at runtime —
// `os.environ[f"{vendor}_API_KEY"]` — and a record of runtime reads misses code that has never
// run, which for a newly deployed agent is all of it. Neither is sufficient, both are cheap, and
// the Usage view shows them separately with the source labelled. A single merged count would be a
// number nobody could act on: "three references" means something different when two are guesses.
//
// WHAT IT SCANS. The agent's CURRENT VERSION, read through `ProjectStore.readCurrent`, which reads
// from the version's manifest rather than from a directory listing — the manifest is what the
// version was declared to be, and a listing is what the store happens to hold. That distinction is
// the project store's own, and this inherits it rather than re-deciding it.
//
// WHOLE-WORD MATCHING, and that is the whole of the cleverness here. `OPENWEATHER_API_KEY` must
// not match inside `OPENWEATHER_API_KEY_BACKUP`, or revoking the first would warn about a file
// that uses the second. Since credential names are `[A-Z][A-Z0-9_]*`, a "word" boundary is any
// character that cannot continue a name — which is not what `\b` means, because `\b` treats `_`
// as a word character and would still match a prefix ending at an underscore.
//
// NO REGEX IS BUILT FROM A CREDENTIAL NAME. Names are validated `^[A-Z][A-Z0-9_]{0,127}$` before
// they reach here, so there is nothing to escape — but building a pattern from a stored value is
// a habit worth not having, and `indexOf` is faster anyway.

export interface ScannedFile {
  path: string;
  content: string;
}

export interface ScanHit {
  name: string;
  /** `tools/weather.py:14`. One-based, because that is what an editor shows. */
  location: string;
}

/** Whether the character at `i` could be part of a credential name. */
function continuesName(text: string, i: number): boolean {
  if (i < 0 || i >= text.length) return false;
  const c = text.charCodeAt(i);
  return (
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z — a lower-case neighbour still means this is a longer word
    (c >= 48 && c <= 57) || // 0-9
    c === 95 // _
  );
}

/**
 * Every place one of `names` appears, as a whole word.
 *
 * Deduplicated by (name, location): a name twice on one line is one hit, because a line is the
 * unit somebody opens. Sorted by path then line, so a rescan of an unchanged tree produces an
 * identical list and the rows it writes do not churn.
 */
export function scanForSecretNames(files: readonly ScannedFile[], names: readonly string[]): ScanHit[] {
  const wanted = [...new Set(names)].filter((n) => n.length > 0);
  if (!wanted.length) return [];
  const seen = new Set<string>();
  const hits: ScanHit[] = [];

  for (const file of files) {
    // Binary or enormous files are skipped rather than scanned: a credential name does not appear
    // in a compiled artefact, and reading one line by line is time spent to find nothing.
    if (file.content.length > 1_000_000 || file.content.includes("\u0000")) continue;
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const name of wanted) {
        let from = 0;
        for (;;) {
          const at = line.indexOf(name, from);
          if (at === -1) break;
          from = at + name.length;
          // The characters either side must not be able to continue a name, or this is a longer
          // identifier that merely starts or ends with the one being looked for.
          if (continuesName(line, at - 1) || continuesName(line, at + name.length)) continue;
          const location = `${file.path}:${i + 1}`;
          const key = `${name}\u0000${location}`;
          if (seen.has(key)) break;
          seen.add(key);
          hits.push({ name, location });
          break;
        }
      }
    }
  }

  hits.sort((a, b) => (a.location === b.location ? a.name.localeCompare(b.name) : a.location.localeCompare(b.location)));
  return hits;
}
