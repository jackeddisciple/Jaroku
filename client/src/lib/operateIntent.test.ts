// A real corpus of phrasings, and the number it scores — Part 3 §6 and §16.
//
// §16 ASKS FOR A NUMBER RATHER THAN A CLAIM: "If deterministic classification cannot reach
// acceptable accuracy on a real corpus, tell me the number rather than shipping something that
// quietly guesses." So this suite prints the figure it achieves, per bucket, and fails on a floor
// rather than on perfection — a corpus that had to be 100% would be a corpus somebody edits until
// it is.
//
// THREE BUCKETS, AND THEY ARE NOT WEIGHTED THE SAME:
//
//   CLEAR QUESTIONS and CLEAR COMMANDS are the ordinary traffic and must be perfect. A miss on
//   either is not a hard case, it is a bug.
//
//   READS-LIKE-BOTH is §13's own requirement — "including the ones that read like both" — and is
//   where a deterministic classifier earns or loses its argument. The figure quoted in the report is
//   this one.
//
// AND THE ASYMMETRY IS ASSERTED SEPARATELY FROM THE ACCURACY. §6: "a question mistaken for a
// command spends real money and touches the real world." So the suite counts the two error
// directions apart, and a question sent to a container is a HARD failure at any accuracy — the
// corpus may lose a command to the record, and may not lose a question to a live agent.
//
// WHAT THIS CORPUS IS AND IS NOT, because the number it prints is only worth what the sentences
// behind it are worth. These are a hundred and five phrasings written by hand, and they are
// therefore a measure of the classifier against the phrasings its author ANTICIPATED — not against
// real traffic, which nobody has yet. A hundred per cent here means the rules cover the cases
// somebody sat down and thought of, which is a real thing to know and is not the same claim as
// "this works". The figure to watch after this ships is how often a person rephrases, which is what
// a mis-route actually costs.
//
//   npm run test:thread-classify

import { classifyOperate, operateLabel } from "./operateIntent.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

type Expected = "question" | "command";
interface Case { text: string; want: Expected }

/** Things somebody types when they want to know what happened. */
const QUESTIONS: string[] = [
  "did that email go out?",
  "Tracey, did you send that mail?",
  "did the refund go through",
  "has the invoice been sent yet?",
  "have you emailed Acme?",
  "what happened with order 4471?",
  "what went wrong yesterday",
  "why did that job fail?",
  "why is it still waiting",
  "how many jobs failed this week?",
  "how much has this cost me",
  "how long did the last one take?",
  "when did it last run?",
  "where did that go",
  "which of those failed?",
  "who asked for that one",
  "what's the status of the invoice run?",
  "whats the status",
  "is anything waiting on me?",
  "are there any failures?",
  "was that one cancelled?",
  "anything failed today?",
  "anything waiting?",
  "status?",
  "did anything break overnight",
  "do you know if that went out",
  "does it retry automatically?",
  "am I blocked on anything",
  "what did you do this morning?",
  "what's it cost so far",
  "how often does this run",
  "is the Acme refund done",
  "has anything gone wrong with the invoices",
  "the last run — what happened?",
  "why did the email to Acme bounce",
  "what was the error on the refund job?",
  "did we ever send that reminder",
  "have those already gone out?",
  "how many did it process",
  "what is the outcome of the last job",
];

/** Things somebody types when they want the agent to do something. */
const COMMANDS: string[] = [
  "send the invoice to Acme",
  "Tracey, send the invoice to Acme",
  "email Acme about the delay",
  "refund order 4471",
  "refund order 4471 — the customer said it never arrived",
  "cancel the subscription for acct_9182",
  "reply to the last customer email",
  "forward that to billing",
  "create a ticket for this",
  "draft a reply to Acme",
  "update the shipping address for order 88",
  "delete the duplicate record",
  "schedule a follow-up for Monday",
  "book the meeting for 3pm",
  "run the nightly reconciliation",
  "retry the failed batch",
  "process the pending refunds",
  "sync the contacts",
  "upload the report",
  "publish the changelog",
  "notify the team about the outage",
  "remind Sam about the invoice",
  "escalate this to support",
  "approve the pending request",
  "assign that to Priya",
  "archive the closed tickets",
  "add a note to the account",
  "set the status to resolved",
  "charge the card on file",
  "invoice Acme for last month",
  "order more stock for SKU-11",
  "trigger the weekly digest",
  "export the results to csv",
  "import yesterday's orders",
  "rename the project to Q3",
  "close ticket 8812",
  "reschedule tomorrow's call",
  "deploy the new version",
  "invite jo@example.com to the workspace",
  "generate the monthly summary",
];

/**
 * The ones that read like both, which is where a deterministic classifier is actually judged.
 *
 * Each is a real thing a person types, and each has a form that suggests one route and a meaning
 * that is the other. The polite imperatives are the largest family: they open with an interrogative
 * and end with a question mark and are instructions.
 */
const BOTH: Case[] = [
  { text: "can you send the invoice?", want: "command" },
  { text: "could you refund order 4471", want: "command" },
  { text: "would you email Acme about this?", want: "command" },
  { text: "will you cancel that subscription", want: "command" },
  { text: "please send the invoice", want: "command" },
  { text: "please retry the failed batch", want: "command" },
  { text: "can you please schedule that for Monday?", want: "command" },
  { text: "I need you to refund order 4471", want: "command" },
  { text: "I'd like you to email the customer", want: "command" },
  { text: "go ahead and send it", want: "command" },
  { text: "now process the pending refunds", want: "command" },
  { text: "can you tell me what happened?", want: "question" },
  { text: "could you show me the failures", want: "question" },
  { text: "can you check if that went out?", want: "question" },
  { text: "send the invoice?", want: "question" },
  { text: "did you send the invoice", want: "question" },
  { text: "have you refunded that order?", want: "question" },
  { text: "has the reminder been sent", want: "question" },
  { text: "what did you send to Acme?", want: "question" },
  { text: "why did the refund fail", want: "question" },
  { text: "how many invoices did you send?", want: "question" },
  { text: "did that email ever go out", want: "question" },
  { text: "was the order cancelled already?", want: "question" },
  { text: "what's the status of the refund?", want: "question" },
  { text: "anything waiting on me?", want: "question" },
];

function score(cases: Case[]): { right: number; wrong: Case[]; questionsDispatched: Case[] } {
  const wrong: Case[] = [];
  const questionsDispatched: Case[] = [];
  let right = 0;
  for (const c of cases) {
    const got = classifyOperate(c.text).kind;
    if (got === c.want) right++;
    else {
      wrong.push(c);
      // THE ERROR DIRECTION THAT COSTS MONEY, tracked apart from the other one.
      if (c.want === "question") questionsDispatched.push(c);
    }
  }
  return { right, wrong, questionsDispatched };
}

const pct = (right: number, total: number): string =>
  `${right}/${total} = ${((right / total) * 100).toFixed(1)}%`;

console.log("\nthe corpus");
const clearQ: Case[] = QUESTIONS.map((text) => ({ text, want: "question" as const }));
const clearC: Case[] = COMMANDS.map((text) => ({ text, want: "command" as const }));
const all = [...clearQ, ...clearC, ...BOTH];

{
  const q = score(clearQ);
  console.log(`  questions that read as questions: ${pct(q.right, clearQ.length)}`);
  for (const c of q.wrong) console.log(`       missed: "${c.text}"`);
  check("every clear question is a question", q.wrong.length === 0, `${q.wrong.length} missed`);

  const c = score(clearC);
  console.log(`  commands that read as commands:   ${pct(c.right, clearC.length)}`);
  for (const w of c.wrong) console.log(`       missed: "${w.text}"`);
  check("every clear command is a command", c.wrong.length === 0, `${c.wrong.length} missed`);

  const b = score(BOTH);
  console.log(`  the ones that read like both:     ${pct(b.right, BOTH.length)}`);
  for (const w of b.wrong) console.log(`       missed: "${w.text}" (wanted ${w.want})`);
  // A FLOOR RATHER THAN PERFECTION. §16 wants the number; a suite that demanded 100% on the hard
  // bucket would be a suite somebody keeps green by deleting the hard cases.
  check(`the ambiguous bucket clears 90% (${pct(b.right, BOTH.length)})`,
    b.right / BOTH.length >= 0.9);

  const total = score(all);
  console.log(`  OVERALL:                          ${pct(total.right, all.length)}`);
  check(`overall accuracy clears 95% (${pct(total.right, all.length)})`,
    total.right / all.length >= 0.95);

  // §6'S ASYMMETRY, AS A HARD FLOOR AT ANY ACCURACY. A command read as a question costs a rephrase.
  // A question read as a command reaches a live container — behind the pre-flight gate, so nothing
  // is spent without being seen, but it is still the failure this whole module is shaped around.
  console.log(`  questions that would have been dispatched: ${total.questionsDispatched.length}`);
  for (const c of total.questionsDispatched) console.log(`       "${c.text}"`);
  check("no question in the corpus is routed to a live container",
    total.questionsDispatched.length === 0, `${total.questionsDispatched.length}`);
}

console.log("\nthe label matches what actually happens");
{
  // §13: "the label matches what actually happens". It does BY CONSTRUCTION — `operateLabel` takes
  // the route rather than the text, so there is no second classification to disagree with the
  // first. Asserted anyway, over the whole corpus, because "by construction" is a claim about code
  // somebody can change.
  let mismatched = 0;
  for (const c of all) {
    const route = classifyOperate(c.text);
    const label = operateLabel(route, "Tracey");
    const saysRun = label.startsWith("This will run");
    if (saysRun !== (route.kind === "command")) mismatched++;
  }
  check("the label never disagrees with the route", mismatched === 0, String(mismatched));
  check("§6: a command's label names the agent and says it will run",
    operateLabel({ kind: "command", confidence: "strong" }, "Tracey") === "This will run Tracey");
  check("§6: a question's label says it reads the record",
    operateLabel({ kind: "question", confidence: "strong" }, "Tracey") === "This reads the record");
}

console.log("\nthe edges");
{
  check("an empty message is a question, harmlessly", classifyOperate("").kind === "question");
  check("whitespace only is a question", classifyOperate("   \n ").kind === "question");
  // THE VOCATIVE IS STRIPPED FOR CLASSIFICATION ONLY, and both directions have to survive it.
  check("a vocative does not change a question",
    classifyOperate("Tracey, did you send it?").kind === "question");
  check("a vocative does not change a command",
    classifyOperate("Tracey, send it").kind === "command");
  check("a name with no comma is not a vocative",
    classifyOperate("Tracey did you send it?").kind === "question");
  // NOTHING DECIDED FALLS TO THE HARMLESS SIDE, and says it was not sure.
  const vague = classifyOperate("the Acme thing");
  check("an undecidable message goes to the record", vague.kind === "question");
  check("...and reports itself as weak", vague.confidence === "weak");
  // A VERB THAT IS NOT FIRST IS NOT AN IMPERATIVE. This is the rung that stops a noun phrase
  // mentioning an action from becoming one.
  check("a verb in the middle of a phrase is not a command",
    classifyOperate("the invoice you sent yesterday").kind === "question");
  check("...even with no question mark",
    classifyOperate("that refund from last week").kind === "question");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
// THE CLIENT'S TSCONFIG HAS NO NODE TYPES, deliberately — it is a browser bundle — so `process` is
// reached the way every other suite in this directory reaches it, through `globalThis`.
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
