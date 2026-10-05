// A suggestion card starts a sentence, and what is typed next is a new word.
//
// THE BUG. "Plan an agent from an idea" put "Plan" in the composer with the caret against it, so the
// brief somebody typed next was glued on — "PlanA personal assistant…" — and that became the agent's
// display name and slug; the plan itself flagged the name as garbled.
//
//   npm run test:composer-suggestions

import { commandOf, draftOf } from "./ComposerSuggestions.tsx";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\na card leaves its command and a space");
{
  check("the command is the sentence's first word", commandOf("Plan an agent from an idea") === "Plan");
  const draft = draftOf("Plan an agent from an idea");
  check("the draft ends in a space, so the next word is a word of its own", draft === "Plan ", JSON.stringify(draft));
  check("...and typing after it reads as a sentence", `${draft}A personal assistant` === "Plan A personal assistant");
  check("an empty sentence leaves nothing, not a lone space", draftOf("   ") === "");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
