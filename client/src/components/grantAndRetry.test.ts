// A change that needed an MCP tool the agent is not granted offers the grant, then the change again.
//
//   npm run test:grant-and-retry

import { createElement } from "react";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const g = globalThis as unknown as Record<string, unknown>;
const store = new Map<string, string>();
g["localStorage"] = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
g["window"] = { location: { search: "", href: "http://localhost/", origin: "http://localhost" }, history: { replaceState() {} } };

const { markup, seed } = await import("../lib/testRender.ts");
const { useBuildStore } = await import("../store/buildStore.ts");
const { DiffCard } = await import("./DiffCard.tsx");

const turn = {
  id: "t1", role: "jaroku", kind: "proposal", status: "noop", agentId: "margot", proposalId: "p1",
  summary: "Not changed: deepwiki's ask_wiki_question isn't in this project's MCP manifest",
  files: [], streaming: [], usage: null,
  grantable: ["deepwiki/ask_wiki_question"], instruction: "answer from the repo's wiki",
};

console.log("\nthe way on from a change that needed a tool");
{
  seed(useBuildStore, { agents: [{ agent_id: "margot", name: "Margot", mcp_tools: [] }] as never });
  const before = markup(createElement(DiffCard, { turn } as never));
  check(before.includes("Grant deepwiki&#x27;s ask_wiki_question to Margot") || before.includes("Grant deepwiki's ask_wiki_question to Margot"),
    "it offers to grant the tool it named", before.slice(0, 500));
  seed(useBuildStore, { agents: [{ agent_id: "margot", name: "Margot", mcp_tools: ["deepwiki/ask_wiki_question"] }] as never });
  const after = markup(createElement(DiffCard, { turn } as never));
  check(after.includes("Try the change again") && !after.includes("Grant deepwiki"), "...and once it is granted, offers the change again");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
