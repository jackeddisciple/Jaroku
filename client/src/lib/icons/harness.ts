// The three lines every icon suite repeats, in one place.
//
// NOT A TEST FRAMEWORK. The client's suites are plain `tsx` scripts on purpose — "what runs in CI
// is what a developer runs locally, spelled the same way" — and six copies of the same counter is
// the only part of that worth sharing.
//
// SYNCHRONOUS `node:fs`, because that is the sliver `node-shims.d.ts` already declares. This client
// has no `@types/node` deliberately: Node's globals inside a browser bundle mean a component can
// reach for `fs` and still compile. Using the surface the shim already has is what keeps that file
// as short as its own comment promises.

import { readdirSync, readFileSync } from "node:fs";

let failures = 0;

export function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

export function done(): void {
  console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
  (globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
}

export const read = (path: string): string => readFileSync(path, "utf8");

/** Every registry key as `group.key`, read from the manifest's SOURCE rather than from its module. */
export function manifestKeys(source: string): { key: string; export: string }[] {
  const out: { key: string; export: string }[] = [];
  let group: string | null = null;
  for (const line of source.split("\n")) {
    const inline = line.match(/^ {2}([A-Za-z]+): \{ (.+) \},$/);
    if (inline) {
      for (const m of inline[2]!.matchAll(/([A-Za-z]+): "([A-Za-z0-9]+Icon)"/g)) {
        out.push({ key: `${inline[1]}.${m[1]}`, export: m[2]! });
      }
      group = null;
      continue;
    }
    const opened = line.match(/^ {2}([A-Za-z]+): \{$/);
    if (opened) { group = opened[1]!; continue; }
    const entry = line.match(/^ {4}([A-Za-z]+): "([A-Za-z0-9]+Icon)",$/);
    if (entry && group) out.push({ key: `${group}.${entry[1]}`, export: entry[2]! });
  }
  return out;
}

/**
 * Every `.ts`/`.tsx` under `src`, minus the generated marks unless asked for.
 *
 * `recursive: true` rather than a hand-rolled walk — the same call `reset.test.ts` uses, for the
 * same reason its comment gives: a list of directories written out by hand goes stale exactly when
 * somebody adds the one that matters.
 */
export function sourceFiles(opts: { includeGenerated?: boolean } = {}): string[] {
  return readdirSync("src", { recursive: true })
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => opts.includeGenerated || !f.includes("icons/generated"))
    .map((f) => `src/${f}`)
    .sort();
}
