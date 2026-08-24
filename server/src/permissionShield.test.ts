// The shield's two hard invariants, which are §12.7 and §12.8.
//
//   7. "Fast mode still confirms a destructive tool call. Verify server-side with the client
//      bypassed."
//   8. "No mode permits writing a protected path, verified with both POSIX and Windows-style
//      separators in the request."
//
// Both are written as things somebody verifies by bypassing the UI, and both have already failed
// once in this codebase in the way the second one names: a block-list entry assembled with `join`
// read `tools\mcp_bridge.py` on Windows, matched the local paths one code path produced, and
// matched nothing in the object store — so the list was empty for the file that carries an agent's
// entire MCP grant. It never failed on macOS or Linux, where the separator happens to agree.
//
// So this suite does not test the composer. It calls the decision functions directly, with the
// spellings a hand-written request would carry.
//
//   npm run test:permission-shield

import { classOf, mustConfirm, normalizePath, permitAttach, permitWrite } from "./permissionShield.ts";
import { PERMISSION_MODES, type PermissionMode } from "./conversationSettings.ts";
import { hostOwnedPaths, readOnlyPaths } from "./projectFs.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const MODES: readonly PermissionMode[] = PERMISSION_MODES;

console.log("\nthe impact ratchet reaches this module intact");
{
  // Only `low` becomes a read. A server's own `readOnlyHint` was already ignored upstream, so a
  // `low` verdict means the tool's NAME read as a retrieval verb — the one signal mcpImpact lets
  // vote in both directions.
  check("low is the only read", classOf("low") === "read");
  check("high is a write", classOf("high") === "write");
  check("an unclassified tool is unknown, not read", classOf(null) === "unknown");
  check("...and so is one nothing recorded", classOf(undefined) === "unknown");
}

console.log("\n§12.7 — every mode confirms a write, and Fast is not an exception");
{
  // The criterion, run against all three modes rather than against Fast alone. Fast is the one the
  // spec names because it is the one somebody would special-case; asserting all three is what
  // stops a fourth mode added later from quietly being the exception.
  for (const mode of MODES) {
    for (const first of [true, false]) {
      const d = mustConfirm(mode, "write", first);
      check(`${mode} confirms a write${first ? " (first call)" : " (repeat call)"}`, d.confirm, d.reason);
      // A repeat call too. "Confirm once per run" is a concession Smart and Fast make for READ
      // tools; extending it to writes would mean one approval authorising every later write in
      // that run, which is the approve-everything mode by another name.
    }
  }
  check("...and the reason names what is at stake",
    mustConfirm("fast", "write", false).reason.includes("change or delete"),
    mustConfirm("fast", "write", false).reason);
}

console.log("\n...and an unclassifiable tool is treated as a write, in every mode");
{
  // mcpImpact's step 4: "A tool called `frobnicate` gets a confirmation prompt. That is correct —
  // nobody, including us, knows what it does." A mode that auto-approved unknowns would defeat the
  // ratchet's whole default from the other end.
  for (const mode of MODES) {
    const d = mustConfirm(mode, "unknown", false);
    check(`${mode} confirms an unclassified tool`, d.confirm, d.reason);
  }
  check("...and says that is why", mustConfirm("fast", "unknown", true).reason.includes("classify"));
}

console.log("\nthe three modes differ only where the invariant leaves room");
{
  // Strict spends nothing: "confirm every tool call" is the spec's own wording, and somebody who
  // chose it has decided the modals are the point.
  check("Strict confirms a read on every call",
    mustConfirm("strict", "read", true).confirm && mustConfirm("strict", "read", false).confirm);

  // Smart keeps Jaroku's existing behaviour: a tool asks once per run, not once per call. Forty
  // modals for a loop is how people learn to click through without reading, which is worse than
  // having no gate — mcpImpact's header makes the same argument.
  check("Smart confirms a read's first call", mustConfirm("smart", "read", true).confirm);
  check("...and not its repeats", !mustConfirm("smart", "read", false).confirm);

  // Fast is exactly one thing: a read-only tool stops asking at all. That is a small difference on
  // purpose — anything larger would have to be bought by weakening §12.7.
  check("Fast auto-approves a read outright", !mustConfirm("fast", "read", true).confirm);
  check("...and its repeats", !mustConfirm("fast", "read", false).confirm);
}

console.log("\n§12.8 — a protected path is refused in every mode, however it is spelled");
{
  const blocked = readOnlyPaths(["tools/postgres.py", "tools/slack.py"]);

  // The file the separator bug went quiet for. Every spelling below names it.
  const SPELLINGS = [
    "tools/mcp_bridge.py",       // the canonical key
    "tools\\mcp_bridge.py",      // Windows separators — the bug that shipped
    "./tools/mcp_bridge.py",     // a leading dot segment
    "tools//mcp_bridge.py",      // a doubled separator
    "tools/./mcp_bridge.py",     // a dot segment in the middle
    "tools/../tools/mcp_bridge.py", // a round trip through the parent
    "/tools/mcp_bridge.py",      // an absolute-looking key
    "tools\\..\\tools\\mcp_bridge.py", // both at once
  ];

  for (const mode of MODES) {
    for (const spelling of SPELLINGS) {
      const d = permitWrite(spelling, blocked, mode);
      check(`${mode} refuses ${spelling}`, !d.allowed, d.reason ?? "ALLOWED");
    }
  }

  // Every host-owned file, not only the bridge. A block list is only as good as its least-checked
  // entry, and these are the four deploy artefacts plus the package marker and the manifest.
  for (const path of hostOwnedPaths()) {
    for (const mode of MODES) {
      check(`${mode} refuses ${path}`, !permitWrite(path, blocked, mode).allowed);
      // ...and the same file written the other way round.
      check(`${mode} refuses ${path} with backslashes`,
        !permitWrite(path.replace(/\//g, "\\"), blocked, mode).allowed);
    }
  }

  // A reviewed connector template is protected for the same reason and through the same list.
  for (const mode of MODES) {
    check(`${mode} refuses a reviewed connector template`,
      !permitWrite("tools/postgres.py", blocked, mode).allowed);
  }
}

console.log("\n...while an ordinary project file is writable in every mode");
{
  // The other half of the claim. A block list that refused everything would pass every assertion
  // above and make the product unusable, so the negative case is checked too.
  const blocked = readOnlyPaths(["tools/postgres.py"]);
  for (const mode of MODES) {
    const d = permitWrite("tools/weather.py", blocked, mode);
    check(`${mode} allows a bespoke tool`, d.allowed, d.reason ?? "");
    check(`${mode} allows agent.py`, permitWrite("agent.py", blocked, mode).allowed);
    // Normalisation must not make an unrelated file collide with a blocked one.
    check(`${mode} allows a file that merely looks like a blocked one`,
      permitWrite("tools/mcp_bridge_helper.py", blocked, mode).allowed);
  }
}

console.log("\na path that climbs out of the project is refused, never clamped");
{
  // The failure this guards is arrived at by being helpful: clamping `../../etc/passwd` to `""`
  // would make it compare unequal to every entry and therefore WRITABLE, which is the opposite of
  // what a normaliser is for.
  for (const escape of ["../etc/passwd", "../../etc/passwd", "..", "../", "..\\..\\windows", "/", "", "."]) {
    check(`normalising ${JSON.stringify(escape)} refuses rather than empties`, normalizePath(escape) === null);
    check(`...and writing it is refused`, !permitWrite(escape, readOnlyPaths([]), "fast").allowed);
  }

  // A `..` that stays inside is fine, because it names a real file in the project.
  check("a parent step that stays inside resolves", normalizePath("tools/../agent.py") === "agent.py");
}

console.log("\n§4.2 — a protected file is ATTACHABLE, which is a different question");
{
  // "Protected files are attachable (reading them as context is fine and useful) but render with a
  // lock and a tooltip stating they can't be edited. Attaching must never imply write capability."
  // The two functions exist separately so nobody later "simplifies" them into agreeing.
  for (const path of hostOwnedPaths()) {
    check(`${path} can be attached as context`, permitAttach(path).allowed);
    check(`...and still cannot be written`, !permitWrite(path, readOnlyPaths([]), "fast").allowed);
  }
  // The escape hatch is closed on this side too — attaching is not a way to read /etc/passwd.
  check("attaching cannot climb out either", !permitAttach("../../etc/passwd").allowed);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;
