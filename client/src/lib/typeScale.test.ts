// The type system, held to typography.pdf.
//
// The specification is LOCKED, which makes drift the only interesting failure — nobody is going to
// disagree with it on purpose. What happens instead is that one of the four places these numbers
// live gets edited and the other three do not: the table in `typeScale.ts`, the `fontSize` block in
// `tailwind.config.js`, the `@import`s in `index.css`, and eight hundred call sites. A Tailwind
// config cannot import a `.ts` module without moving the whole config to TypeScript, so the ladder
// genuinely is written twice — and a copy guarantees nothing about agreeing with its original
// unless something checks it. This is that check.
//
// THE SPECIFICATION'S OWN NUMBERS ARE SPELLED OUT BELOW rather than derived from `TYPE_SCALE`. A
// table compared against itself passes just as happily with a rung deleted, and every assertion in
// this file would then be asserting that the code agrees with the code.
//
// The two rules that are not numbers are §04 and §05 — which face carries what — and they are
// checked the way `test:reset` checks its store directory: by reading the source. §04 cannot be
// asserted call site by call site, because whether `{t.name}` is a tool name or a file path is
// something only a person reading the line can tell. What it CAN assert is that the mono face is
// confined to the files that are about code at all, so a `font-mono` appearing in the Activity
// dashboard or the sidebar fails here rather than in review.
//
//   npm run test:type-scale

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  BASE_STEP,
  LOADED_WEIGHTS,
  MONO_STACK,
  SANS_STACK,
  TYPE_SCALE,
  WEIGHT,
  tailwindFontSize,
  type TypeStepName,
} from "./typeScale.ts";
import { TYPE } from "./tokens.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = `${HERE}..`;
const CLIENT = `${SRC}/..`;
const read = (path: string): string => readFileSync(`${CLIENT}/${path}`, "utf8");

/** Every .ts/.tsx under src, so a rule about the source can be asked of all of it. */
function sources(): { path: string; text: string }[] {
  // `recursive` rather than a walk of my own: it is the one readdir overload these suites have
  // types for, and a hand-rolled walk needs `statSync`, which they do not.
  return readdirSync(SRC, { recursive: true })
    .map((entry) => String(entry).replace(/\\/g, "/"))
    .filter((path) => /\.tsx?$/.test(path))
    .map((path) => ({ path, text: readFileSync(`${SRC}/${path}`, "utf8") }));
}

/** A line of prose about CSS is not a call site. This file's own comments would fail its rules. */
const isComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);

const SOURCES = sources();

console.log("\n§02's table, transcribed from the specification rather than from the code");
{
  // Size, weight, line height — the three columns of §02, in its own order.
  const SPEC: Record<string, [number, number, number]> = {
    display: [32, 600, 40],
    page: [24, 600, 30],
    section: [16, 600, 22],
    title: [16, 600, 22],
    body: [14, 400, 20],
    label: [13, 500, 18],
    caption: [12, 400, 16],
    tiny: [11, 500, 14],
  };

  check("eight rungs, and no ninth", Object.keys(TYPE_SCALE).length === 8, Object.keys(TYPE_SCALE).join(", "));
  for (const [name, [size, weight, lineHeight]] of Object.entries(SPEC)) {
    const step = TYPE_SCALE[name as TypeStepName];
    check(
      `${name} is ${size}px / ${weight} / ${lineHeight}px`,
      !!step && step.size === size && step.weight === weight && step.lineHeight === lineHeight,
      step ? `${step.size}px / ${step.weight} / ${step.lineHeight}px` : "missing",
    );
  }
  // §02 lists Section and Title as separate rows with identical numbers. Two jobs, one metric —
  // and a suite that did not say so would let somebody "tidy" one of them away.
  check(
    "section and title are two rungs with one set of numbers",
    TYPE_SCALE.section.size === TYPE_SCALE.title.size
      && TYPE_SCALE.section.weight === TYPE_SCALE.title.weight
      && TYPE_SCALE.section.lineHeight === TYPE_SCALE.title.lineHeight,
  );
  // The ladder must descend. A rung out of order is the one error that still renders plausibly.
  const sizes = Object.values(TYPE_SCALE).map((s) => s.size);
  check("and it descends", sizes.every((s, i) => i === 0 || s <= sizes[i - 1]!), sizes.join(" → "));
}

console.log("\n...and the Tailwind config, which is the second copy of it");
{
  const config = read("tailwind.config.js");
  const expected = tailwindFontSize();

  for (const [name, [size, { lineHeight, fontWeight }]] of Object.entries(expected)) {
    // The literal line the config must carry, spelled the way the config spells it.
    const line = `${name}: ["${size}", { lineHeight: "${lineHeight}", fontWeight: "${fontWeight}" }],`;
    check(`config carries ${name} exactly as the table has it`, config.includes(line), line);
  }
  // And nothing else — a ninth entry in the config is a rung nothing on the ladder knows about.
  const declared = [...config.matchAll(/^\s{8}([a-z]+): \["\d+px"/gm)].map((m) => m[1]);
  check(
    "the config declares those eight and no others",
    declared.length === 8 && declared.every((d) => d! in TYPE_SCALE),
    declared.join(", "),
  );
}

console.log("\n§01's two families, and the absence of a third");
{
  const config = read("tailwind.config.js");
  for (const family of [["sans", SANS_STACK], ["mono", MONO_STACK]] as const) {
    const [key, stack] = family;
    const block = config.match(new RegExp(`\\b${key}: \\[([^\\]]*)\\]`));
    const names = block ? [...block[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
    check(`${key} is ${stack[0]}, with §01's fallbacks after it`, names.join("|") === stack.join("|"), names.join(", "));
  }
  // The display serif is gone, and this is the assertion that keeps it gone. It was a deliberate
  // decision once — see the note in index.css — so the way it comes back is somebody restoring it
  // for one screen, which is exactly how it spread the first time.
  check("no third family is declared", !/\bserif: \[/.test(config), "a serif family is back in the config");
  const serifCallSites = SOURCES.filter((f) => /\bfont-serif\b/.test(f.text)).map((f) => f.path);
  check("and nothing asks for one", serifCallSites.length === 0, serifCallSites.join(", "));
}

console.log("\nthe stylesheet loads §03's three weights of each family and nothing else");
{
  const css = read("src/index.css");
  const imports = [...css.matchAll(/@import "([^"]+)"/g)].map((m) => m[1]!);

  for (const family of ["geist-sans", "geist-mono"]) {
    for (const weight of LOADED_WEIGHTS) {
      const spec = `@fontsource/${family}/${weight}.css`;
      check(`${family} ${weight} is loaded`, imports.includes(spec), spec);
    }
  }
  check("and only those six", imports.length === 6, imports.join(", "));
  // §03 calls 700 "rare; reserved for strong emphasis, not normal headings". A weight nothing
  // loads is the only way that stays true — reaching for it costs a font file, in a diff.
  check(
    "700 is on the ladder and off the bundle",
    WEIGHT.bold === 700 && !imports.some((i) => i.includes("700")),
  );
  // A stale package is a font that still ships. `npm uninstall` and a dead `@import` fail here.
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
  const fonts = Object.keys(pkg.dependencies).filter((d) => d.startsWith("@fontsource"));
  check(
    "and the only font packages are the two Geist families",
    fonts.sort().join(", ") === "@fontsource/geist-mono, @fontsource/geist-sans",
    fonts.join(", "),
  );
}

console.log("\nthe reading default is a rung, not a number somebody chose");
{
  const css = read("src/index.css");
  const body = css.match(/body \{[\s\S]*?\}/)?.[0] ?? "";
  check(`the body is set to text-${BASE_STEP}`, body.includes(`text-${BASE_STEP}`), body.replace(/\s+/g, " ").trim());
  // The old base was a bare `font-size: 12px`. Any bare font-size here is a base off the ladder.
  check("and carries no font-size of its own", !/font-size:/.test(body));
}

console.log("\nevery size in the client is one of the eight");
{
  // THE ASSERTION THIS SUITE EXISTS FOR. The client rendered ten sizes across eight hundred call
  // sites before this pass, four of which existed only because a component was matched to whatever
  // sat beside it. One arbitrary size is how that starts again.
  const strays: string[] = [];
  for (const file of SOURCES) {
    if (file.path === "lib/typeScale.ts" || file.path === "lib/typeScale.test.ts") continue;
    file.text.split("\n").forEach((line, i) => {
      const m = line.match(/\btext-\[[0-9.]+(px|rem|em)\]/);
      if (m) strays.push(`${file.path}:${i + 1} ${m[0]}`);
    });
  }
  check("no call site writes its own size", strays.length === 0, strays.slice(0, 8).join("; "));

  // ...and no `text-` class names something that does not exist. This is the failure mode that
  // survives every other check in the file: Tailwind emits nothing at all for a class it does not
  // recognise, so the element renders at whatever it inherited and looks ALMOST right. It found a
  // real one the first time it ran — a copy button whose failed state asked for `text-error`
  // against a palette whose red is `err`, so the one state that had to be noticed was uncoloured.
  //
  // ONLY INSIDE STRING LITERALS. `text-overflow` and `text-align` are CSS properties discussed in
  // comments, and a rule that read prose would fail on the paragraph explaining it.
  const RUNGS = new Set(Object.keys(TYPE_SCALE));
  // The palette, read from the config rather than listed here, so a new colour needs no edit here.
  const config = read("tailwind.config.js");
  const PALETTE = new Set([...config.matchAll(/^\s{8}([a-z]+): "#/gm)].map((m) => m[1]!));
  // Tailwind's own `text-*` utilities that are not sizes or palette colours.
  const BUILT_IN = new Set([
    "left", "right", "center", "justify", "start", "end", "wrap", "nowrap", "balance", "pretty",
    "clip", "ellipsis", "transparent", "current", "inherit", "white", "black",
  ]);
  const unknown = new Set<string>();
  for (const file of SOURCES) {
    if (file.path === "lib/typeScale.test.ts") continue;
    file.text.split("\n").forEach((line) => {
      if (isComment(line)) return;
      // `(?<![-\w])` because the colour system's own tokens are spelled `--color-text-primary`,
      // and a `\b` before `text` is satisfied by the hyphen in front of it — so the palette files
      // read as forty call sites for a class called `text-primary` that does not exist.
      for (const m of line.matchAll(/(?<![-\w])text-([a-z][a-z0-9]*)\b/g)) {
        const word = m[1]!;
        if (RUNGS.has(word) || PALETTE.has(word) || BUILT_IN.has(word)) continue;
        unknown.add(`${file.path}: text-${word}`);
      }
    });
  }
  check("and every text- class names something that exists", unknown.size === 0, [...unknown].join("; "));
}

console.log("\n...including the roles in tokens.ts, which used to hold sizes of their own");
{
  for (const [role, value] of Object.entries(TYPE)) {
    const rung = value.match(/\btext-([a-z]+)\b/)?.[1];
    check(`TYPE.${role} stands on a rung`, !!rung && rung in TYPE_SCALE, value);
    // The rungs carry their own weight. A weight class beside one is a second opinion about a
    // decision already made, and the two drift the day the rung moves.
    check(`TYPE.${role} does not restate a weight`, !/\bfont-(normal|medium|semibold|bold)\b/.test(value), value);
  }
}

console.log("\n§04: the mono face is confined to the files that are about code");
{
  // Not a rule about call sites — whether `{t.name}` is a tool name or a file path is something
  // only a person reading the line can tell, and §05 is the judgement they have to make. This is
  // the rule that CAN be checked: a `font-mono` in a file that has nothing to do with code is
  // wrong whatever the string says, and that is where the two hundred removed in this pass were.
  const ALLOWED = new Set([
    // Source, snippets, and the paths and line numbers beside them.
    "components/AgentFiles.tsx", "components/AgentTabs.tsx", "components/AgentVersions.tsx",
    "components/CodeViewer.tsx", "components/FileList.tsx", "components/GitHubHistory.tsx",
    "components/GraphView.tsx", "components/ReviewRegion.tsx",
    // Diffs and their hunk headers.
    "components/DiffCard.tsx", "components/GitHubStaging.tsx", "components/StateDiff.tsx",
    // Logs, terminal output and stack traces.
    "components/BackendFailure.tsx", "components/firstrun/FirstRun.tsx", "components/WorkspacePanel.tsx",
    // A deployed job's error, which is a stack trace out of somebody else's container — and its
    // input, but ONLY when that input parses as JSON. Both are on `MONO_IS_FOR` by name. The second
    // is the one worth stating: the Cockpit's detail panel decides the face per block rather than
    // per file, because an agent's input is usually a sentence a person typed and occasionally a
    // structured document, and §05's test is "would fixed-width columns materially help somebody
    // parse it" rather than "does this look technical".
    "components/WorkDetail.tsx",
    // Literal payloads.
    "components/McpConfirmModal.tsx", "components/StateBranchEditor.tsx",
    // Environment variable names and .env paths, quoted inside prose.
    "components/DeployPanel.tsx", "components/McpPanel.tsx",
    "components/onboarding/ComposerColumn.tsx", "components/composer/ShieldControl.tsx",
    // A type annotation on a state field — the one identifier on a plan card that is code.
    "components/PlanCard.tsx",
    // Credentials and the keys they are stored under.
    "components/SecretsGate.tsx", "components/SecretsList.tsx", "components/SecretsPanel.tsx",
    // The two components that take the face as a PROP; their callers are covered by the rest.
    "components/Chip.tsx", "components/Select.tsx",
  ]);

  const holders = SOURCES.filter((f) => /\bfont-mono\b/.test(f.text) && !f.path.endsWith(".test.ts")).map((f) => f.path);
  const unexpected = holders.filter((p) => !ALLOWED.has(p));
  check("no file outside the code surfaces asks for it", unexpected.length === 0, unexpected.join(", "));
  // And the other direction: an entry that has stopped being true is an allowance nobody removed,
  // which is how a list like this becomes a list of everything.
  const stale = [...ALLOWED].filter((p) => !holders.includes(p));
  check("and every allowance is still in use", stale.length === 0, stale.join(", "));
}

console.log("\n...and the same rule where it arrives as a PROP rather than as a class");
{
  // THE HALF THE CHECK ABOVE CANNOT SEE. `Chip` and `Select` take the face as a `mono` prop, so a
  // caller asking for it writes no class at all — and six of them were asking for it on an agent
  // name, two model ids, a connector label, a branch and a tool's provenance chip. Every one is on
  // §04's SANS list by name, and none of them appears in a `font-mono` census.
  //
  // It took a screenshot of the running app to find them, which is the argument for this block: the
  // rule is worth what it can be broken by, and a prop is as easy to pass as a class is to write.
  const ALLOWED = new Set([
    // A file attachment is a path; a ref or a PR on the same chip is a label. Both files pass the
    // prop conditionally, which is the distinction §04 is asking for.
    "components/composer/AttachmentRail.tsx",
    "components/GitHubAttach.tsx",
    // A repository subdirectory, which is a path.
    "components/GitHubPanel.tsx",
    // The two components that define the prop.
    "components/Chip.tsx",
    "components/Select.tsx",
  ]);
  const callers: string[] = [];
  for (const file of SOURCES) {
    file.text.split("\n").forEach((line, i) => {
      if (isComment(line)) return;
      // `mono` alone on its own line is the JSX shorthand for `mono={true}`; the conditional form
      // is `mono={…}` and is what the allowed files use.
      if (/^\s*mono\s*$/.test(line) || /\bmono=\{true\}/.test(line)) {
        if (!ALLOWED.has(file.path)) callers.push(`${file.path}:${i + 1}`);
      }
    });
  }
  check("nothing asks for the mono face unconditionally outside the code surfaces", callers.length === 0, callers.join(", "));
}

console.log("\n§04's Sans list, at the call sites the specification names by name");
{
  // Four of §04's Sans entries, checked where they actually render. These are not a sample — they
  // are the four that were monospaced when the specification arrived, so each one is a line that
  // had to change and could quietly change back.
  const at = (path: string, needle: string): string =>
    (SOURCES.find((f) => f.path === path)?.text.split("\n").find((l) => l.includes(needle)) ?? "");

  check("an agent's slug is Sans", !/font-mono/.test(at("components/AgentCard.tsx", "title={agent.slug}")));
  check("a version is Sans", !/font-mono/.test(at("components/GitHubPanel.tsx", "v{row.version}")));
  check("a model name is Sans", !/font-mono/.test(at("components/StatusBar.tsx", "${run.provider}/${run.model}")));
  check("a figure is Sans", !/font-mono/.test(at("components/StatRow.tsx", "{s.value}")));
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
// The same exit the other client suites use: this runs under tsx with no node types in scope.
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
