// An edit that could not use an MCP tool names the one it needed, so it can be granted.
//
// THE BUG. "Not changed: deepwiki's ask_wiki_question isn't in this project's MCP manifest" — and the
// only way on anybody found was re-planning the agent from scratch. The grant is a person's decision
// and an edit must not make it; but the edit can say WHICH tool, and the card can offer the grant.
//
//   npm run test:edit-grant

import { namedUngrantedTools } from "./editor.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const servers = [
  { id: "deepwiki", tools: [{ name: "ask_wiki_question" }, { name: "read_wiki_structure" }] },
  { id: "linear", tools: [{ name: "create_issue" }] },
];

console.log("\nthe tool an edit needed and the agent lacks");
{
  const said = "Not changed: deepwiki's ask_wiki_question isn't in this project's MCP manifest";
  check("a tool named in the answer and not granted is offered",
    JSON.stringify(namedUngrantedTools(servers, new Set(), said)) === JSON.stringify(["deepwiki/ask_wiki_question"]));
  check("...but not once it is granted",
    namedUngrantedTools(servers, new Set(["deepwiki/ask_wiki_question"]), said).length === 0);
  check("a tool named in the request counts too, whatever the case",
    namedUngrantedTools(servers, new Set(), "use CREATE_ISSUE when a build fails")[0] === "linear/create_issue");
  check("a name inside a longer word is not a mention",
    namedUngrantedTools(servers, new Set(), "my_create_issue_helper").length === 0);
  check("nothing named, nothing offered", namedUngrantedTools(servers, new Set(), "make it friendlier").length === 0);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
