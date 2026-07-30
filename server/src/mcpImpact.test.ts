// Impact classification for discovered MCP tools.
//
// Both failure directions are real bugs, so both are tested:
//   * a missed high lets an unreviewed third-party tool take an irreversible action silently
//   * a false high gates `get_message`, and a gate that fires on everything is a gate
//     nobody reads
//
//   npm run test:mcp-impact

import { classify, tokenize } from "./mcpImpact.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const impactOf = (name: string, description?: string, annotations?: Record<string, unknown>) =>
  classify({ name, description, annotations }).impact;

// --- 1. the server may raise, never lower ---------------------------------------------
{
  check("destructiveHint is believed",
    impactOf("tidy_up", "Tidies things", { destructiveHint: true }) === "high");
  check("readOnlyHint:false is believed (it raises)",
    impactOf("frobnicate", "Frobnicates", { readOnlyHint: false }) === "high");

  // The whole trust model in one assertion: a server cannot certify its own tool safe.
  check("readOnlyHint:true does NOT lower a clearly-writing tool",
    impactOf("delete_everything", "Deletes it all", { readOnlyHint: true }) === "high");
  check("readOnlyHint:true does NOT lower an unreadable tool",
    impactOf("frobnicate", "", { readOnlyHint: true }) === "high");

  const v = classify({ name: "delete_record", annotations: { readOnlyHint: true } });
  check("an overruled server claim is explained to the user",
    v.reason.includes("does not get to certify"), v.reason);
  check("an honest read tool needs no caveat",
    !classify({ name: "get_record" }).reason.includes("certify"));
}

// --- 2. the name, which by convention leads with its verb -----------------------------
{
  const high = ["create_issue", "delete_record", "send_message", "update_page", "post_comment",
    "write_file", "execute_query", "revoke_token", "upload_attachment", "reset_password"];
  for (const n of high) check(`high: ${n}`, impactOf(n) === "high");

  const low = ["get_issue", "list_items", "read_page", "search_docs", "fetch_url",
    "describe_table", "lookup_user", "count_rows", "preview_diff", "resolve_reference"];
  for (const n of low) check(`low: ${n}`, impactOf(n) === "low");
}

// --- 3. the two ways a name lies about itself -----------------------------------------
{
  // A write hiding behind a read's leading verb. One high verb anywhere is enough.
  check("get_or_create_issue is high despite leading with get",
    impactOf("get_or_create_issue") === "high");
  check("find_and_replace is high", impactOf("find_and_replace") === "high");
  check("search_then_delete is high", impactOf("search_then_delete") === "high");

  // A read whose OBJECT happens to be a word that is also a verb. `message` is a noun here,
  // and gating every mail reader is the false-friction failure.
  check("get_message is low (message is the object, not the verb)",
    impactOf("get_message") === "low");
  check("list_orders is low", impactOf("list_orders") === "low");
  check("read_email is low", impactOf("read_email") === "low");
  check("search_notes is low", impactOf("search_notes") === "low");
  check("send_message is still high", impactOf("send_message") === "high");

  // Exact matching, never stemming: a past-tense mention of a mutation is not a mutation.
  check("list_deleted_items is low", impactOf("list_deleted_items") === "low");
  check("get_archived_pages is low", impactOf("get_archived_pages") === "low");
}

// --- 4. tokenization across the naming conventions in the wild ------------------------
{
  check("camelCase splits", tokenize("createIssue").join(",") === "create,issue");
  check("snake_case splits", tokenize("create_issue").join(",") === "create,issue");
  check("kebab-case splits", tokenize("create-issue").join(",") === "create,issue");
  check("dotted namespaces split", tokenize("linear.createIssue").join(",") === "linear,create,issue");
  check("digits survive", tokenize("get_v2_user").join(",") === "get,v2,user");
  check("empty is empty", tokenize("").length === 0);

  check("camelCase classifies", impactOf("deleteRecord") === "high");
  check("kebab-case classifies", impactOf("list-items") === "low");
  // A namespaced name: the leading token is the namespace, so the verb is found after it.
  check("namespaced write classifies", impactOf("linear_create_issue") === "high");
  check("namespaced read classifies", impactOf("linear_list_issues") === "low");
}

// --- 5. the description may RAISE, never lower ----------------------------------------
{
  // Prose is a weak signal, so it gets the same deal as the server's own annotations.
  check("an opaque name with a writing description is high",
    impactOf("frobnicate", "Creates a new widget in the workspace") === "high");
  check("conjugated verbs are matched (prose, unlike an identifier, is inflected)",
    classify({ name: "frobnicate", description: "Deletes a widget" })
      .reason.includes('"delete" writes'));

  // ...and no path from a description to "low". "Returns the newly created issue" opens
  // like a read and describes a write; believing it would open the gate silently.
  check("a reading description cannot lower an opaque tool",
    impactOf("frobnicate", "Lists every widget in the workspace") === "high");
  check("a read-shaped description of a write cannot lower it either",
    impactOf("frobnicate", "Returns the newly created issue") === "high");

  // Only the opening words, so a scary word deep in the prose is not evidence about
  // THIS tool. (It stays high here only because the name was already unreadable.)
  const late = classify({
    name: "frobnicate",
    description: "Returns the widgets in a workspace, including ones a user chose to delete last week",
  });
  check("a passing mention outside the lead window is not what gated it",
    late.reason.includes("nothing in its name or description"), late.reason);

  // The name always wins over the description — it is the more reliable signal.
  check("a clear name beats a misleading description",
    impactOf("delete_widget", "Retrieves and lists things") === "high");
  check("a clear read name beats a scary description",
    impactOf("list_widgets", "Deletes nothing, but you could delete these later") === "low");
}

// --- 6. the default, which is the point -----------------------------------------------
{
  check("an unreadable tool is high", impactOf("frobnicate") === "high");
  check("an unreadable tool with an unreadable description is high",
    impactOf("xyzzy", "plugh plover") === "high");
  check("no name at all is high", impactOf("") === "high");

  const v = classify({ name: "frobnicate" });
  check("the default explains itself",
    v.reason.includes("nothing in its name or description"), v.reason);

  // Never throws on a malformed advertisement from an unreviewed server.
  const junk = classify({
    name: undefined as unknown as string,
    description: 42 as unknown as string,
    annotations: "not an object" as unknown as Record<string, unknown>,
  });
  check("malformed advertisement classifies rather than throwing", junk.impact === "high");
}

// --- 7. every verdict carries a usable reason -----------------------------------------
{
  const names = ["create_issue", "get_message", "frobnicate", "get_or_create_issue"];
  check("every verdict has a non-empty reason",
    names.every((n) => classify({ name: n }).reason.trim().length > 10));
  check("the reason quotes the word it matched",
    classify({ name: "send_message" }).reason.includes('"send"'));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
