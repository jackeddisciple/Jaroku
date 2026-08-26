// The four tiers, and the two things that must never be lost.
//
// THE ASSERTION THIS FILE EXISTS FOR is `two files in different trees stay distinguishable`. That
// is the whole argument for middle truncation over a right-edge fade — `tools/we…` and `tools/tr…`
// are the same string to a reader scanning twenty rows — and it is the one property that a
// plausible-looking rewrite could quietly lose while every other case still passed.
//
// The second is the extension. Losing `.py` from a name is worse than losing a directory, because
// the extension is often the only thing separating a generated stub from its own test file.
//
//   npm run test:truncate-path

import { truncatePath } from "./truncatePath.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

console.log("\ntier 1 — it fits");
{
  check(truncatePath("agent.py", 40) === "agent.py", "a short path is rendered plain");
  check(truncatePath("tools/weather.py", 16) === "tools/weather.py", "exactly at the budget is still plain");
  // Zero means "not measured yet", not "no room". Flashing an ellipsis on the first frame of every
  // list would truncate paths that were never going to need it.
  check(truncatePath("tools/weather.py", 0) === "tools/weather.py", "an unmeasured element truncates nothing");
}

console.log("\ntier 2 — collapse the middle");
{
  const out = truncatePath("tools/deep/nested/weather.py", 20);
  check(out === "tools/…/weather.py", "the first segment and the filename survive whole", out);
  check(out.endsWith("weather.py"), "...and the filename is intact, which is the whole point");
  // Collapsing has to actually save something. For a short path the collapsed form can be LONGER
  // than the original, and rendering a longer string to indicate shortening is absurd.
  check(truncatePath("a/b/c.py", 8) === "a/b/c.py", "a collapse that would not save a character is not made");
  // Leftover budget is spent putting leading segments back, because `agents/…/client.py` is the
  // same string for two agents and `agents/weather/…/client.py` is not.
  check(
    truncatePath("agents/weather/tools/client.py", 28) === "agents/weather/…/client.py",
    "spare room goes on the next leading segment rather than being left unused",
    truncatePath("agents/weather/tools/client.py", 28),
  );
}

console.log("\ntier 3 — shorten the leading directory");
{
  const out = truncatePath(".astro/content/blog/2024/january/post.schema.json", 26);
  check(out.endsWith("post.schema.json"), "the filename is still whole at tier 3", out);
  check(out.includes("…/"), "...and the leading directory is shortened rather than dropped", out);
  check(out.length <= 26, "...within the budget", `${out.length}`);
  // SHORTENED, NOT DROPPED: a stub of the top-level directory still says which tree this came
  // from, which is the disambiguation the whole variant exists for.
  check(out.startsWith("."), "...keeping enough of it to place the file", out);
}

console.log("\ntier 4 — the extension outlives everything");
{
  const out = truncatePath("tools/an_extremely_long_generated_module_name.py", 14);
  check(out.endsWith(".py"), "the extension survives even when the filename does not", out);
  check(out.length <= 14, "...within the budget", `${out.length}`);
  check(truncatePath("a_very_long_bare_filename.json", 12).endsWith(".json"), "...for a bare filename too");
  // A leading dot is a HIDDEN FILE, not a suffix. Read as an extension it would leave an empty
  // stem and tier 4 would protect the entire name while claiming to have shortened it.
  check(truncatePath(".env", 3) === ".e…", "a dotfile has no extension, so its whole name is stem");
}

console.log("\nthe property the variant exists for");
{
  // The failure a right-edge fade produces, asserted as the thing that must not happen.
  const a = truncatePath("tools/weather.py", 12);
  const b = truncatePath("tools/translate.py", 12);
  check(a !== b, "two files in different trees stay distinguishable", `${a} vs ${b}`);
  check(a.endsWith(".py") && b.endsWith(".py"), "...and both still read as Python");

  // Same filename, sibling trees. With room for the distinguishing segment they stay apart; with
  // none, both collapse to `agents/…/client.py` and the row is honestly out of space — which is a
  // limit of the width, not of the algorithm, and is what the tooltip carrying the full path is
  // for.
  const deepA = truncatePath("agents/weather/tools/client.py", 28);
  const deepB = truncatePath("agents/slack/tools/client.py", 28);
  check(deepA !== deepB, "same-named files in sibling trees stay apart when there is room", `${deepA} vs ${deepB}`);
  check(deepA.includes("weather") && deepB.includes("slack"), "...by keeping the segment that distinguishes them");
}

console.log("\nand a sentence is not a path");
{
  // WHAT THIS COMPONENT DOES TO PROSE, asserted so nobody has to discover it on a screen. It keeps
  // the last segment and collapses everything before it — correct and load-bearing for a path, and
  // catastrophic for a diagnosis, because the last segment of "could not read this agent's files:
  // no such object: ws/…/v2/.env.example" is `.env.example`. The Graph tab rendered exactly that:
  // a filename under a heading it had no visible relationship to, reading as though `.env.example`
  // were somehow responsible for there being no graph, with the real sentence one hover away.
  //
  // THE FIX IS NOT IN THIS FUNCTION. It is that the two are two fields now — `error` and
  // `errorKey` — so prose is rendered as prose and only the key comes here. This assertion
  // documents WHY that split exists, and fails if somebody ever "improves" the truncator to guess
  // at prose, which would break the distinguishability property above.
  const diagnosis = "could not read this agent's files: no such object: ws/abc/agents/def/v2/.env.example";
  const mangled = truncatePath(diagnosis, 24);
  check(
    !mangled.includes("could not read"),
    "a sentence fed to the path truncator loses its verb, which is why the key travels separately",
    mangled,
  );
  check(mangled.endsWith(".env.example"), "...and keeps only its last segment", mangled);
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
// Reached through globalThis, like every other suite here: the client has no @types/node on
// purpose, so that a component touching `process` fails to compile rather than fails to run.
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
