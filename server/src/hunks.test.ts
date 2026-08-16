// Reconstructing a file from a subset of its own diff, with nothing else in the room.
//
// TWO IDENTITIES CARRY THIS WHOLE FEATURE, and every other assertion below is a specific way one of
// them can fail:
//
//   SELECT EVERY HUNK AND YOU GET THE WORKING FILE, BYTE FOR BYTE.
//   SELECT NONE AND YOU GET THE BASE FILE, BYTE FOR BYTE.
//
// If either is ever false, the reconstruction is doing something the diff did not describe — and
// §B.4's argument that this is bookkeeping over content Jaroku already produced, rather than the
// patch-application v0.1.0 rejected, is simply not true. So they are checked against every fixture
// in this file rather than once.
//
// The interesting failures are all about bytes nobody looks at: a CRLF file quietly converted, a
// missing trailing newline added back, a hunk applied against line numbers another hunk has already
// moved. Each of those renders on GitHub as a change the user did not make, in a commit they
// deliberately narrowed.
//
//   npm run test:hunks

import { applyHunks, discardHunk, hunksBetween, isWholeFileSelection } from "./hunks.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

/** The two identities, asserted together, because a fixture that holds one and not the other lies. */
function identities(label: string, base: string, working: string): void {
  const hunks = hunksBetween(base, working);
  const all = hunks.map((h) => h.index);
  check(applyHunks(base, working, all) === working, `${label}: every hunk reproduces the working file`,
    JSON.stringify(applyHunks(base, working, all)));
  check(applyHunks(base, working, []) === base, `${label}: no hunk reproduces the base file`,
    JSON.stringify(applyHunks(base, working, [])));
}

const BASE = [
  "def get_weather(city: str) -> str:",
  "    query = build(city)",
  "    return db.run(query)",
  "",
  "def other():",
  "    pass",
  "    pass",
  "    pass",
  "    pass",
  "    pass",
  "",
  "def third():",
  "    log('a')",
  "    return 1",
  "",
].join("\n");

// Two independent edits, far enough apart to be separate hunks: one near the top, one near the
// bottom. This is the shape §B.4.1's screenshot shows — a retry wrapper and a log line.
const WORKING = [
  "def get_weather(city: str) -> str:",
  "    query = build(city)",
  "    with retry(3):",
  "        return db.run(query)",
  "",
  "def other():",
  "    pass",
  "    pass",
  "    pass",
  "    pass",
  "    pass",
  "",
  "def third():",
  "    return 1",
  "",
].join("\n");

console.log("\nthe two identities, on the ordinary case");
identities("two hunks", BASE, WORKING);

console.log("\nwhat a hunk knows about itself");
{
  const hunks = hunksBetween(BASE, WORKING);
  check(hunks.length === 2, "two edits three lines apart are two hunks", String(hunks.length));
  check(hunks[0]!.index === 0 && hunks[1]!.index === 1, "indices are positions in the file's list, which is what a checkbox names");
  check(hunks[0]!.additions === 2 && hunks[0]!.deletions === 1, "figures are counted from the hunk's own lines");
  check(hunks[1]!.additions === 0 && hunks[1]!.deletions === 1, "a pure removal has no additions");
  // `@@ -40,2 +43,3 @@` alone tells a person nothing about what they are staging.
  //
  // The first hunk's leading context IS the `def` line, which is the commonest shape there is — an
  // edit to a function's first statement. A search that started one line higher would walk past it
  // and name whatever came before, so this is the case that pins the at-or-above rule.
  check(hunks[0]!.header.includes("def get_weather"), "the header names the enclosing definition", hunks[0]!.header);
  // Git's rule is about where the HUNK starts, not where the changed line is: the second hunk's
  // context opens inside `other`, so that is what it is called, even though the edit is below in
  // `third`. Naming the function containing the edit would need a second traversal to disagree with
  // every other tool that renders this header.
  check(hunks[1]!.header.includes("def other"), "and it is the definition the hunk's first line sits in", hunks[1]!.header);
}

console.log("\nstaging one hunk and not the other");
{
  const hunks = hunksBetween(BASE, WORKING);
  const first = applyHunks(BASE, WORKING, [0]);
  check(first.includes("with retry(3):"), "the staged hunk lands");
  check(first.includes("    log('a')"), "and the unstaged one is left exactly as the base has it");
  check(!first.includes("query = build(city)\n    return db.run(query)"), "the staged range is genuinely replaced");

  const second = applyHunks(BASE, WORKING, [1]);
  check(!second.includes("with retry(3):"), "the other way round, the first hunk stays unstaged");
  check(!second.includes("    log('a')"), "and the second one's removal takes effect");

  // The failure v0.1.0 rejected patches over, expressed as a test: hunk 1's line numbers are read
  // against the UNCHANGED base, so staging hunk 0 first cannot move them.
  check(applyHunks(BASE, WORKING, [0, 1]) === WORKING, "staging both in either order is the working file");
  check(applyHunks(BASE, WORKING, [1, 0]) === WORKING, "the selection is a set, not a sequence to replay");
}

console.log("\nline endings survive a partial stage");
{
  // A project can carry CRLF; projectFs does not rewrite it and neither may this. A stager that
  // normalised would turn "stage one hunk" into "rewrite every line ending in the file".
  const crlfBase = "alpha\r\nbeta\r\ngamma\r\ndelta\r\nepsilon\r\neta\r\ntheta\r\niota\r\nkappa\r\nzeta\r\n";
  const crlfWork = "alpha\r\nBETA\r\ngamma\r\ndelta\r\nepsilon\r\neta\r\ntheta\r\niota\r\nkappa\r\nZETA\r\n";
  identities("crlf", crlfBase, crlfWork);
  const hunks = hunksBetween(crlfBase, crlfWork);
  const staged = applyHunks(crlfBase, crlfWork, [0]);
  check(!/(?<!\r)\n/.test(staged), "no line lost its carriage return", JSON.stringify(staged));
  check(staged.includes("BETA\r\n") && staged.includes("zeta\r\n"), "the staged line changed and the other did not");
}

console.log("\na file with no trailing newline");
{
  // Whether a file ends in one is a fact the diff records with its own marker. Adding or removing
  // that byte on every stage shows on GitHub as a change to the last line, forever.
  identities("no trailing newline", "one\ntwo\nthree", "one\nTWO\nthree");
  identities("gaining one", "one\ntwo\nthree", "one\ntwo\nthree\n");
  identities("losing one", "one\ntwo\nthree\n", "one\ntwo\nthree");

  const staged = applyHunks("one\ntwo\nthree", "one\nTWO\nthree", [0]);
  check(staged === "one\nTWO\nthree", "no newline is invented at the end", JSON.stringify(staged));
}

console.log("\nthe empty and whole-file edges");
{
  identities("empty base", "", "a\nb\n");
  identities("emptied file", "a\nb\n", "");
  identities("unchanged", "a\nb\n", "a\nb\n");
  check(hunksBetween("a\nb\n", "a\nb\n").length === 0, "an unchanged file has nothing to stage");
  check(applyHunks("a\nb\n", "a\nb\n", []) === "a\nb\n", "and staging nothing from nothing is the file itself");

  // Adjacent edits collapse into one hunk, which is jsdiff's behaviour and not a thing to fight:
  // a checkbox per LINE is not what §B.4.1 asks for, and splitting them here would produce two
  // selections that cannot both be applied without moving each other.
  const packed = hunksBetween("a\nb\nc\n", "A\nB\nc\n");
  check(packed.length === 1, "two touching edits are one hunk, one checkbox", String(packed.length));
}

console.log("\ndiscarding a hunk reverts its range and nothing else");
{
  const after = discardHunk(BASE, WORKING, 1);
  check(after.includes("with retry(3):"), "the hunk somebody kept is still there");
  check(after.includes("    log('a')"), "and the discarded one is back to the base's version");
  check(after !== BASE && after !== WORKING, "a discard is neither a whole-file revert nor a no-op");

  // Discarding every hunk one at a time ends at the base; discarding none leaves the file alone.
  check(discardHunk(BASE, discardHunk(BASE, WORKING, 1), 0) === BASE, "discarding both lands exactly on the base");
  check(discardHunk(BASE, WORKING, 99) === WORKING, "discarding a hunk that is not there changes nothing");
}

console.log("\nwhether the selection is still one version");
{
  const hunks = hunksBetween(BASE, WORKING);
  check(isWholeFileSelection([{ hunks, selected: [0, 1] }]), "every hunk of every file is a whole-file selection");
  check(!isWholeFileSelection([{ hunks, selected: [0] }]), "one hunk short and §B.4.2's hand-staged route applies");
  check(
    !isWholeFileSelection([{ hunks, selected: [0, 1] }, { hunks, selected: [0] }]),
    "a partial selection anywhere makes the whole push hand-staged, not just that file",
  );
  check(isWholeFileSelection([]), "nothing staged is vacuously whole — the caller decides there is nothing to push");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
