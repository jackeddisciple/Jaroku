// I2: the icon set is a build-time dependency, and shipped code never reaches for it.
//
// WHY THIS IS AN INVARIANT AND NOT A PREFERENCE. `@hugeicons/react` renders a mark by walking an
// array of path tuples at render time, which makes the icon package a RUNTIME dependency of the
// composer's control bar — the one row in this product that has to be on screen before anything
// else is. An offline desktop build, a cold dev server, a tree-shake that goes wrong: all of them
// land on the same seven buttons. Committed inline SVG has none of those failure modes, and the
// only thing keeping it that way is that nothing under `src/` may import from `@hugeicons/*`.
//
// IMPORTS, NOT MENTIONS. Two files talk about the package in their header comments — they are
// explaining why it is not imported — and a suite that grepped for the string would fail on the
// prose that documents the rule.
//
//   npm run test:icon-deps

import { check, done, read, sourceFiles } from "./harness.ts";

const pkg = JSON.parse(read("package.json")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

console.log("\nthe package is classified as a build-time tool");
{
  check("@hugeicons/core-free-icons is a devDependency",
    "@hugeicons/core-free-icons" in pkg.devDependencies);
  check("...and is NOT a runtime dependency",
    !("@hugeicons/core-free-icons" in pkg.dependencies));
  // The renderer is the thing that made it a runtime dependency in the first place, so its absence
  // is asserted separately and by name.
  check("@hugeicons/react is not installed at all",
    !("@hugeicons/react" in pkg.dependencies) && !("@hugeicons/react" in pkg.devDependencies));
  check("no other @hugeicons package is a runtime dependency",
    Object.keys(pkg.dependencies).every((d) => !d.startsWith("@hugeicons/")));
}

console.log("\n...and nothing that ships imports from it");
{
  // `includeGenerated`, deliberately: the committed marks are the output of reading that package
  // and must not have kept a reference to it. SUITES ARE EXCLUDED because they are not shipped and
  // because two of them have to import the package in order to check it against the manifest —
  // which is the point of them.
  const files = sourceFiles({ includeGenerated: true }).filter((f) => !f.includes(".test."));
  let offenders = 0;
  for (const file of files) {
    const text = read(file);
    // An import statement, or a dynamic `import(...)` — the two ways a module can arrive at runtime.
    const imports = /(^|\n)\s*import\s[^;]*from\s+["']@hugeicons\/|import\(\s*["']@hugeicons\//.test(text);
    if (imports) { offenders++; console.log(`  FAIL ${file} imports @hugeicons`); }
  }
  check(`no file under src/ imports @hugeicons (${files.length} checked)`, offenders === 0);
}

console.log("\n...except the generator, which is the one thing that is supposed to");
{
  const gen = read("scripts/gen-icons.mjs");
  check("scripts/gen-icons.mjs reads the package", gen.includes('import("@hugeicons/core-free-icons")'));
  // It lives outside `src/` for exactly this reason — it is authoring-time tooling, so it is not in
  // the tree the bundler walks and cannot end up in a chunk.
  check("...and it is not under src/", !gen.includes("src/lib/icons/generated/index"));
}

console.log("\nno mark is fetched over the network");
{
  const files = sourceFiles({ includeGenerated: true }).filter((f) => !f.includes(".test."));
  let hotlinks = 0;
  for (const file of files) {
    const text = read(file);
    // A URL IN A STRING LITERAL, which is what a `src`, an `href` or a `fetch` would need — not a
    // URL in a comment. Two of these files cite the icon set's page in their header to say where
    // the shapes came from, which is attribution rather than a network dependency, and a suite
    // that failed on it would be punishing the file for documenting itself.
    if (/["'`]https?:\/\/[^"'`\s]*hugeicons\.com/.test(text)) {
      hotlinks++;
      console.log(`  FAIL ${file} hotlinks hugeicons.com`);
    }
  }
  check("nothing under src/ hotlinks the icon site", hotlinks === 0);
}

done();
