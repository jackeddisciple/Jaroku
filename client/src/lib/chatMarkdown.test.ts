// A conversation as Markdown — what Share Chat puts on the clipboard.
//
//   npm run test:chat-markdown

import type { ChatTurn } from "../store/chatStore.ts";
import { chatMarkdown } from "./chatMarkdown.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const turns = [
  { id: "1", role: "user", text: "  How do I retry a webhook?\n" },
  { id: "2", role: "jaroku", kind: "reply", status: "done", agentId: "", text: "Use backoff:\n\n```ts\nretry(3)\n```" },
  { id: "3", role: "jaroku", kind: "reply", status: "error", agentId: "", text: "   " },
  { id: "4", role: "jaroku", kind: "info", tone: "muted", text: "Stopped here.\nNothing was spent." },
  { id: "5", role: "jaroku", kind: "plan", status: "ready", planId: null, revision: 1, prompt: "", raw: "Tools: http", plan: null, warnings: [], usage: null },
  { id: "6", role: "jaroku", kind: "gen", status: "done", agentId: "a", files: ["graph.py", "tools.py"], usage: null, planUsage: null },
  { id: "7", role: "jaroku", kind: "proposal", status: "applied", agentId: "a", proposalId: null, summary: "Add a timeout", files: [{}], streaming: [], usage: null },
  { id: "8", role: "jaroku", kind: "work", workItemId: "w", input: null },
] as unknown as ChatTurn[];

const md = chatMarkdown("Webhook\nretries", turns);

console.log("\nthe conversation reads as a document");
check("the title is a one-line heading", md.startsWith("# Webhook retries\n\n"), JSON.stringify(md.slice(0, 30)));
check("the user's words are theirs, trimmed", md.includes("**You**\n\nHow do I retry a webhook?"));
check("a reply keeps its code fence", md.includes("**Jaroku**\n\nUse backoff:\n\n```ts\nretry(3)\n```"));
check("an empty reply is left out", !md.includes("**Jaroku**\n\n   ") && (md.match(/\*\*Jaroku\*\*\n\n/g) ?? []).length === 1);
check("a note is quoted, every line of it", md.includes("> Stopped here.\n> Nothing was spent."));
check("a plan is its plan text", md.includes("**Jaroku — plan**\n\nTools: http"));
check("a generation names its files", md.includes("generated 2 files:\n\n- `graph.py`\n- `tools.py`"));
check("a proposal names its change and its size", md.includes("**Jaroku — proposed change** (1 file)\n\nAdd a timeout"));
check("a job with no input is still said to have been sent", md.includes("**Job sent to the agent**"));
check("the document ends with one newline", md.endsWith("\n") && !md.endsWith("\n\n"));

console.log("\nan untitled, empty chat is still a document");
check("it is a heading and nothing else", chatMarkdown("   ", []) === "# Chat\n");

console.log(fail === 0 ? "\nall chat-markdown checks passed" : `\n${fail} chat-markdown check(s) FAILED`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
