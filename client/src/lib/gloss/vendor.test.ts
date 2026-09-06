// §8's `test:gloss-vendor`: the scratch directory is gone, Three.js is the pinned file, and the
// provenance record is real.
//
// THREE OF THESE ASSERTIONS ARE ABOUT AN ABSENCE, which is the shape this failure actually takes.
// Nothing goes red when a vendored file quietly imports out of the scratch checkout — it builds on the
// machine that has that directory and fails on every machine that does not, which is CI, the
// desktop build, and everybody else. Same for `three` arriving from npm: the app runs, and every
// avatar in every workspace is drawn by a version of Three.js nobody chose.
//
// AND ONE IS ABOUT THE CLOSURE, which is the mistake this extraction was actually one step away
// from making. The specification's §2.1 lists seven gloss files; `grig.js` needs eighteen more to
// resolve. A missing one is not a type error and not a lint error — it is a module resolution
// failure at runtime, in a browser, on the first card that tries to draw. So every relative import
// in the vendored tree is walked and its target has to exist.
//
//   npm run test:gloss-vendor

// PATHS RELATIVE TO `client/`, and `node:fs` only, because that is the whole Node surface this
// package declares. `node-shims.d.ts` says adding to it should feel like a decision; this suite
// needed one function it did not have — see the note on `existsSync` there — and reaches for
// nothing else. `npm run` sets the working directory, which is what every other suite here assumes.

import { existsSync, readdirSync, readFileSync } from "node:fs";

const GLOSS = "src/lib/gloss";
const VENDOR = "vendor";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** Every source file under a directory, recursively, as a path this process can open. */
function sources(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .filter((name) => /\.(ts|tsx|js|mjs)$/.test(name))
    .map((name) => `${dir}/${name}`);
}

// --- 1. the scratch directory is nowhere -----------------------------------------------------

console.log("\nthe scratch checkout never reaches the client");
{
  // THE ONE THING §0 SAYS MUST NOT GO WRONG, checked rather than remembered. The scratch directory is
  // in `.gitignore` so it cannot be committed; this is the other half — a file that IMPORTS from it
  // would be committed, would typecheck on the machine that has the directory, and would fail
  // everywhere else.
  // THE NEEDLE IS ASSEMBLED RATHER THAN WRITTEN OUT, and so is the one below it, because this file
  // is under `client/src` and the scan includes it. A literal here matches itself and the suite
  // fails on its own source — so the alternative would be excluding this file from its own check,
  // which is the weaker rule: the assertion is "no file", and it should mean no file.
  const scratch = ["avatar", "codebase"].join("");
  const offenders = sources("src").filter((f) =>
    readFileSync(f, "utf8").includes(scratch),
  );
  check(`nothing under client/src mentions ${scratch}`, offenders.length === 0,
    offenders.join(", "));
}

// --- 2. Three.js is the pinned file, not a dependency ----------------------------------------

console.log("\nThree.js is pinned, not installed");
{
  // I3: freezing the recipes protects identity only if the code that draws them is frozen too. A
  // `three` in `dependencies` is a version range, and a minor release that changes a default on
  // `MeshPhysicalMaterial` restyles every agent in every workspace with nothing in the diff to say
  // so. `devDependencies` counts as well — Vite would resolve a bare specifier out of either.
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const named = { ...pkg.dependencies, ...pkg.devDependencies };
  check("no `three` in client/package.json", !("three" in named), named["three"] ?? "");

  check("client/vendor/three.module.js exists", existsSync(`${VENDOR}/three.module.js`));

  // AND NO BARE SPECIFIER SURVIVED THE REWRITE. Upstream resolves `three` through an import map in
  // its HTML, which this repository does not have; a file that kept the bare specifier resolves to
  // nothing under Vite and under `tsx` alike. Seven lines were rewritten and PROVENANCE.md lists
  // them — this is what fails if an eighth arrives with a later copy.
  const bareThree = new RegExp(`from\\s+["']${["thr", "ee"].join("")}["']`);
  const bare = sources(GLOSS).filter((f) => bareThree.test(readFileSync(f, "utf8")));
  check("every bare Three.js specifier was rewritten to the vendored path", bare.length === 0,
    bare.join(", "));
}

// --- 3. the closure resolves -----------------------------------------------------------------

console.log("\nthe vendored tree is complete");
{
  // WHAT ALMOST WENT WRONG. §2.1 names seven files; the import closure of those seven is
  // twenty-five. A missing member is not a type error — `allowJs` is off, so `tsc` never opens
  // these files — and not a lint error. It is a resolution failure in a browser on the first card
  // that draws, which is the last place anybody wants to find it.
  const files = sources(GLOSS).filter((f) => f.endsWith(".js"));
  check("twenty-five files were vendored", files.length === 25, `${files.length}`);

  const missing: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const here = file.slice(0, file.lastIndexOf("/"));
    for (const match of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      if (!existsSync(flatten(`${here}/${match[1]}`))) missing.push(`${file} → ${match[1]}`);
    }
  }
  check("every relative import resolves to a file that exists", missing.length === 0,
    missing.join(", "));
}

// --- 4. the provenance record ----------------------------------------------------------------

console.log("\nPROVENANCE.md says where this came from");
{
  const path = `${GLOSS}/PROVENANCE.md`;
  check("PROVENANCE.md exists", existsSync(path));
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";

  // A FULL SHA, NOT AN ABBREVIATION AND NOT A BRANCH NAME. "main" is not a version — it is a
  // pointer that moves — and the whole point of the record is that somebody in a year can check
  // out exactly the tree these files came from.
  const sha = /\b[0-9a-f]{40}\b/.exec(text);
  check("it names a 40-character commit SHA", sha !== null, sha?.[0] ?? "none found");

  check("it names the upstream repository", text.includes("albertobeiz/kindergrimm"));
  check("it names the licence", /Unlicense/i.test(text));

  // THE SENTENCE THE WHOLE FILE EXISTS FOR (I3). Recipes are frozen so an agent keeps its face;
  // that only holds while the code drawing them is frozen too, and the person about to "just fix
  // the lighting" is the reader this line is for.
  check("it states that editing here restyles every agent", /restyle/i.test(text));

  // AND THE MODIFICATIONS, which is the half of a provenance record people skip. A vendored file
  // that was edited without the edit being written down is a file nobody can diff against upstream
  // ever again.
  check("it records the modifications made during extraction",
    /modification/i.test(text) && text.includes("../../../vendor/three.module.js"));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

/**
 * Resolve `..` and `.` in a path by hand.
 *
 * `node:path` is not in the shim and this is the only place that needs it — one loop against a
 * whole module's declarations is the trade `node-shims.d.ts` asks callers to make.
 */
function flatten(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "." || part === "") continue;
    if (part === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}
