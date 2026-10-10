// Every node of an agent's graph gets its own mark, by what it does, in a colour that cannot be
// mistaken for a status.
//
// What it exists to stop coming back: a five-step agent drawn as five identical robots; a step
// called `send_slack` drawn as Slack in an agent that has no Slack connector; a tile whose colour
// reads as "running" or "failed"; and a graph whose icons change between two looks at it.
//
//   npm run test:graph-node-icons

import { FIXED, MARK_HUES, marksFor, wordsOf } from "./graphNodeIcons.ts";
import type { FlowRole } from "../lib/graphLayout.ts";
import { NODE_HUE, STATUS, SURFACE } from "../lib/tokens.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const n = (id: string, role: FlowRole = "model") => ({ id, role });

// Liven v1, as the layout hands it over.
const LIVEN = [
  n("__start__", "start"), n("extract_jd"), n("extract_resume"), n("score_candidate"),
  n("shortlist_note"), n("decline_note"), n("__end__", "end"), n("decide:score_candidate", "decision"),
];

console.log("§1 a name is read for what the step does");
{
  check("words come apart on underscores", wordsOf("extract_jd").join(" ") === "extract jd");
  check("...and on camelCase", wordsOf("sendSlackMessage").join(" ") === "send slack message");
  const m = marksFor(LIVEN);
  const key = (id: string) => m.get(id)?.key;
  check("extract_jd is a document being searched", key("extract_jd") === "fileSearch", String(key("extract_jd")));
  check("extract_resume is the same kind, so the next mark of it", key("extract_resume") === "scan", String(key("extract_resume")));
  check("score_candidate is judging", key("score_candidate") === "analytics", String(key("score_candidate")));
  check("shortlist_note is judging too — the verb leads", key("shortlist_note") === "target", String(key("shortlist_note")));
  check("decline_note is writing", ["pencilEdit", "messageEdit"].includes(String(key("decline_note"))), String(key("decline_note")));
  check("Start, End and the fork wear their own marks",
    m.get("__start__") === FIXED.start && m.get("__end__") === FIXED.end && m.get("decide:score_candidate") === FIXED.decision);
}

console.log("\n§2 no two nodes in a graph look the same");
{
  const m = marksFor(LIVEN);
  const keys = [...m.values()].map((x) => x.key);
  check("Liven's eight nodes wear eight marks", new Set(keys).size === keys.length, keys.join(" "));
  // Six steps all named for a kind that has five marks, then fifteen names that say nothing recognisable.
  const same = Array.from({ length: 6 }, (_, i) => n(`score_${i}`));
  const opaque = Array.from({ length: 15 }, (_, i) => n(`step_${i + 1}`));
  const many = marksFor([...same, ...opaque]);
  const manyKeys = [...many.values()].map((x) => x.key);
  check("twenty-one steps wear twenty-one marks", new Set(manyKeys).size === 21, manyKeys.join(" "));
  check("a kind's pool overflows into the generic one, not into a repeat",
    many.get("score_5")?.kind === "glyph" && !["analytics", "target", "award", "chartBar", "star"].includes(many.get("score_5")!.key),
    String(many.get("score_5")?.key));
  const huge = marksFor(Array.from({ length: 120 }, (_, i) => n(`zz_${i}`)));
  check("more steps than marks still draws every tile", huge.size === 120 && [...huge.values()].every((x) => x.Icon));
}

console.log("\n§3 a brand only for a connector the agent has");
{
  const steps = [n("send_slack_message"), n("read_inbox"), n("tools", "tool")];
  const without = marksFor(steps, { connectors: [] });
  check("without the Slack connector, send_slack_message is sending, not Slack",
    without.get("send_slack_message")?.kind === "glyph", JSON.stringify(without.get("send_slack_message")?.key));
  const withSlack = marksFor(steps, { connectors: ["slack"] });
  // The verb leads for kinds, but a connector the agent has outranks it: the logo says where.
  check("with it, send_slack_message is Slack's logo", withSlack.get("send_slack_message")?.key === "brand:slack");
  check("...and the tool node does not wear a logo another step already wears",
    withSlack.get("tools")?.key !== "brand:slack", String(withSlack.get("tools")?.key));
  const gmailOnly = marksFor([n("tools", "tool"), n("summarize_thread")], { connectors: ["gmail"] });
  check("a tool node with exactly one connector wears that connector's logo", gmailOnly.get("tools")?.key === "brand:gmail");
  const two = marksFor([n("tools", "tool")], { connectors: ["gmail", "slack"] });
  check("with two, it is the agent's tools in general", two.get("tools")?.key === "sourceCode" || two.get("tools")?.key === "wrench",
    String(two.get("tools")?.key));
  const mail = marksFor([n("read_inbox")], { connectors: ["gmail"] });
  check("a word naming a connector's service draws its logo", mail.get("read_inbox")?.key === "brand:gmail", String(mail.get("read_inbox")?.key));
}

console.log("\n§4 the same graph is drawn the same way every time");
{
  const a = [...marksFor(LIVEN, { connectors: ["slack"] }).entries()].map(([k, v]) => `${k}=${v.key}`).join(",");
  const b = [...marksFor(LIVEN, { connectors: ["slack"] }).entries()].map(([k, v]) => `${k}=${v.key}`).join(",");
  check("two calls agree", a === b);
}

console.log("\n§5 a colour says what kind of step, never how it is doing");
{
  const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  const lum = (hex: string) => {
    const c = channels(hex).map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };
  const dist = (a: string, b: string) => {
    const [ar, ag, ab] = channels(a);
    const [br, bg, bb] = channels(b);
    return Math.hypot(ar - br, ag - bg, ab - bb);
  };
  for (const [name, hex] of Object.entries(NODE_HUE)) {
    check(`${name} reaches 3:1 on the tile`, contrast(hex, SURFACE.panel) >= 3, contrast(hex, SURFACE.panel).toFixed(2));
    // 55 is the colour system's own floor for "near-identical" (test:colour-system §04).
    check(`${name} is not mistakable for running or failed`,
      dist(hex, STATUS.pending) > 55 && dist(hex, STATUS.error) > 55,
      `${dist(hex, STATUS.pending).toFixed(0)} from amber, ${dist(hex, STATUS.error).toFixed(0)} from red`);
  }
  check("every hue a mark can wear is one of these, or ink", MARK_HUES.every((h) => Object.values(NODE_HUE).includes(h as never) || h === "#1D1D1B"),
    MARK_HUES.join(" "));
  const m = marksFor(LIVEN);
  const hues = new Set([...m.values()].flatMap((x) => (x.kind === "glyph" ? [x.hue] : [])));
  check("Liven is drawn in more than one colour", hues.size >= 4, [...hues].join(" "));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
