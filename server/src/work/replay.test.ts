// The recorded answer, and the two things that make it safe to have — §13's fixtures paragraph.
//
// §13 ASKS FOR THE FIXTURE AND FOR ONE PROPERTY OF IT: "Record an explainer fixture the way
// `JAROKU_GEN_FIXTURE` and friends already work, so the whole answering path is replayable at zero
// cost. NOTE THE WARNING THAT ALREADY EXISTS about a forgotten `JAROKU_PLAN_FIXTURE` feeding stale
// text into a real call, and make sure yours cannot do the same thing quietly."
//
// THE FAILURE MODE HERE IS WORSE THAN THE PLANNER'S AND IN A DIFFERENT DIRECTION. A stale PLAN
// corrupts a generation, which produces a project somebody then looks at. A stale ANSWER is a
// paragraph about what somebody's agent did, in the product's own voice, with citations on it —
// there is no downstream step to notice, and the person reading it is the last check. So this
// fixture is not quiet in two ways the other three are:
//
//   IT IS INERT UNDER `NODE_ENV=production`, whatever the variable says. A development convenience
//   that an environment variable can switch on in production is a way to make a deployment answer
//   every question with the same recorded paragraph.
//
//   IT SAYS SO IN THE PROSE, not only in the log. The other three replay into a card somebody can
//   see is canned; this replays into a sentence, where a console line nobody is watching would be
//   the only difference between a fixture and a fact.
//
// AND THE MODAL, WHICH IS THE OTHER HALF OF §9. "A waiting item is answered in the conversation,
// through the existing `resolveMcpConfirm` and the existing modal. Not a second confirm command,
// not a second dialog. THE MODAL MUST NOT BE ABLE TO TELL WHICH SURFACE IT WAS OPENED FROM." That
// is a property of what the component reads, so it is checked by reading it.
//
//   npm run test:convo-replay

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { explainFixture, streamExplain, FIXTURE_NOTICE } from "../explainer.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "..", "fixtures", "explain-record.txt");

console.log("\nwhen the fixture applies");
{
  check("no variable means no fixture", explainFixture({}) === null);
  check("a path that exists is used", explainFixture({ JAROKU_EXPLAIN_FIXTURE: FIXTURE }) === FIXTURE);
  // A TYPO IS A MISSING FILE, and the honest response is to call the model rather than to fail —
  // the same shape `generator.ts` takes for its own fixture.
  check("a path that does not exist falls through to the model",
    explainFixture({ JAROKU_EXPLAIN_FIXTURE: join(HERE, "nope.txt") }) === null);
  // THE ONE THAT IS NOT LIKE THE OTHER THREE.
  check("§13: it is inert in production whatever the variable says",
    explainFixture({ JAROKU_EXPLAIN_FIXTURE: FIXTURE, NODE_ENV: "production" }) === null);
  check("...and is live in development", 
    explainFixture({ JAROKU_EXPLAIN_FIXTURE: FIXTURE, NODE_ENV: "development" }) === FIXTURE);
}

console.log("\nwhat a replayed answer looks like");
{
  const had = process.env["JAROKU_EXPLAIN_FIXTURE"];
  process.env["JAROKU_EXPLAIN_FIXTURE"] = FIXTURE;
  let text = "";
  let done = false;
  let errored = "";
  await streamExplain("CONTEXT THAT MUST NOT APPEAR", "did that email go out?", {
    onDelta: (t) => { text += t; },
    onDone: () => { done = true; },
    onError: (m) => { errored = m; },
    onUsage: () => { check("a replay never reports usage", false, "onUsage fired"); },
  });
  if (had === undefined) delete process.env["JAROKU_EXPLAIN_FIXTURE"];
  else process.env["JAROKU_EXPLAIN_FIXTURE"] = had;

  check("the answer completes", done && !errored, errored);
  check("it is the recorded text", text.includes("that went out"));
  // §13'S REQUIREMENT, ASSERTED IN THE PROSE ITSELF.
  check("§13: it says out loud that it was replayed", text.startsWith(FIXTURE_NOTICE), text.slice(0, 60));
  // THE QUESTION AND THE CONTEXT ARE IGNORED, which is what "replayed" means — and asserting it is
  // how a future change that quietly started calling the model on the fixture path would be caught.
  check("...and the context is not in it", !text.includes("CONTEXT THAT MUST NOT APPEAR"));
  // NO USAGE MEANS NO CHARGE. A replay that metered would put a row in the ledger for a call that
  // never happened, on the surface whose whole argument is that its numbers are real.
  check("a replay is free, so nothing is metered", true);
}

console.log("\nthe fixture is a real answer in the shape the resolver expects");
{
  const body = readFileSync(FIXTURE, "utf8");
  // IT CARRIES CITATIONS, because a fixture with none would exercise the answering path and NOT the
  // citation path — which is half of what it exists to make replayable.
  const cites = [...body.matchAll(/\[work:([0-9a-fA-F-]{36})\]/g)];
  check("it cites work items", cites.length >= 3, String(cites.length));
  // AND IT CONTAINS A REFUSAL, so the honesty path has something to replay too: §8's "I have no
  // record of that" is the sentence this whole part is judged on and it belongs in the fixture.
  check("§8: it contains a refusal rather than only findings",
    /no record of/i.test(body), body.slice(0, 80));
}

console.log("\n§9: the modal cannot tell which surface opened it");
{
  // A PROPERTY OF WHAT THE COMPONENT READS, so it is checked by reading it. §9: "Not a second
  // confirm command, not a second dialog. The modal must not be able to tell which surface it was
  // opened from." The way that stops being true is somebody adding a branch on the current tab to
  // make it look different in the Cockpit — which would be a second dialog wearing one file.
  const modal = readFileSync(join(HERE, "..", "..", "..", "client", "src", "components", "McpConfirmModal.tsx"), "utf8");
  check("it reads no UI state at all", !/uiStore|useUiStore/.test(modal));
  check("...and no thread state", !/threadStore|useThreadStore/.test(modal));
  check("...and no work state", !/workStore|useWorkStore/.test(modal));
  // AND IT ANSWERS THROUGH THE ONE COMMAND THAT ALREADY EXISTS.
  check("§9: it resolves through the existing resolveMcpConfirm", /sendResolveMcpConfirm/.test(modal));

  // MOUNTED ONCE, AT THE ROOT. A modal rendered inside a view is a modal that only exists on that
  // view — which is exactly the thing §9 says must not happen, seen from the other side.
  const app = readFileSync(join(HERE, "..", "..", "..", "client", "src", "App.tsx"), "utf8");
  check("it is mounted once, above every surface", (app.match(/<McpConfirmModal \/>/g) ?? []).length === 1);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
