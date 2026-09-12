// The OpenAI-compatible transport — the shape of the request, and the parsing of the stream.
//
// WHAT IS WORTH A SUITE AND WHAT IS NOT. Not the network: `fetch` against a real provider is a
// credential, a bill and a flake. What this asserts is the three things that are wrong SILENTLY:
//
//   THE BASE URL. Meta's is `https://api.meta.ai/v1` and it has to be byte-identical to the one
//   `runtime/jaroku_runner/models.py` already uses — the run path and the chat path reaching the
//   same provider at two addresses is the drift this codebase refuses everywhere else, and it would
//   show up as one of them working.
//
//   `include_usage`. Without it a streamed completion reports no token counts at all, so §10's cost
//   line would read "unknown" on every non-Anthropic chat turn forever — honest, useless, and
//   invisible until somebody wondered why only Claude turns had a figure.
//
//   THE CACHED-TOKEN SPLIT. OpenAI's `prompt_tokens` INCLUDES the cached ones and Anthropic's
//   `input_tokens` excludes them. `costFor`'s `inputTokens` slot is the uncached one, so handing
//   over the total charges cache reads at the full input rate — `pricing.ts`'s header says that
//   overstates cost by up to 10x, and it would do it quietly on exactly the long conversations
//   where caching matters most.
//
//   npm run test:openai-chat

import { readFileSync } from "node:fs";

import {
  OPENAI_COMPATIBLE_BASE, isOpenAiCompatible, keyNameFor, streamOpenAiChat,
  type OpenAiUsage,
} from "./openaiChat.ts";
import { PROVIDER_ENV_KEY } from "./providers.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// --- the endpoints ----------------------------------------------------------------------------

console.log("\nthe endpoints");
{
  check("openai is reachable", OPENAI_COMPATIBLE_BASE.openai === "https://api.openai.com/v1");
  check("meta is reachable", OPENAI_COMPATIBLE_BASE.meta === "https://api.meta.ai/v1");
  // THE ONE ASSERTION THAT CANNOT BE MADE ANY OTHER WAY: the Python runtime's own constant. The run
  // path and the chat path reach Muse Spark at the same address or one of them is wrong, and the
  // failure would be a 404 on whichever nobody tried.
  const models = readFileSync(new URL("../../runtime/jaroku_runner/models.py", import.meta.url), "utf8");
  const theirs = /META_BASE_URL = "([^"]+)"/.exec(models)?.[1];
  check(`meta's base URL matches the runtime's (${theirs})`, theirs === OPENAI_COMPATIBLE_BASE.meta,
    `${theirs} vs ${OPENAI_COMPATIBLE_BASE.meta}`);

  // ANTHROPIC IS DELIBERATELY ABSENT. It has its own SDK, its own streaming shape and its own cache
  // accounting; a base URL here would invite somebody to route a Claude call through this file and
  // lose the cached-token counts §10 prices apart.
  check("anthropic is not on this transport", !isOpenAiCompatible("anthropic"));
  check("...and neither is a provider nobody configured", !isOpenAiCompatible("cohere"));
  check("openai and meta are", isOpenAiCompatible("openai") && isOpenAiCompatible("meta"));

  // THE KEY NAMES COME FROM THE ONE TABLE. Meta's own docs say `MODEL_API_KEY`; this codebase uses
  // `META_API_KEY` and `providers.ts` explains why — "in a product with three providers it names
  // none of them" — so the check is against ours rather than against theirs.
  check("openai's key name", keyNameFor("openai") === PROVIDER_ENV_KEY.openai);
  check("meta's key name", keyNameFor("meta") === PROVIDER_ENV_KEY.meta);
  check("...and it is META_API_KEY rather than Meta's own MODEL_API_KEY", keyNameFor("meta") === "META_API_KEY");
}

// --- the request, captured rather than sent ---------------------------------------------------

type Captured = { url: string; init: RequestInit };

/** Stand in for `fetch`, answering with a scripted SSE body. */
function fakeFetch(frames: string[], status = 200, headers: Record<string, string> = {}): {
  calls: Captured[]; fn: typeof fetch;
} {
  const calls: Captured[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (status !== 200) {
      return {
        ok: false, status, body: null,
        text: async () => frames.join(""),
        headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      } as unknown as Response;
    }
    const encoder = new TextEncoder();
    let i = 0;
    return {
      ok: true, status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () =>
            i < frames.length
              ? { done: false, value: encoder.encode(frames[i++]!) }
              : { done: true, value: undefined },
        }),
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fn };
}

const real = globalThis.fetch;
const withFetch = async (fn: typeof fetch, body: () => Promise<void>): Promise<void> => {
  globalThis.fetch = fn;
  try { await body(); } finally { globalThis.fetch = real; }
};

console.log("\nthe request");
{
  const { calls, fn } = fakeFetch(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', "data: [DONE]\n\n"]);
  await withFetch(fn, async () => {
    await streamOpenAiChat(
      {
        provider: "meta", model: "muse-spark-1.3", apiKey: "k-secret",
        system: "the rules", messages: [{ role: "user", content: "a question" }], maxTokens: 900,
      },
      { onDelta: () => {}, onUsage: () => {} },
    );
  });
  const sent = calls[0]!;
  const body = JSON.parse(String(sent.init.body));
  check("it posts to the provider's chat completions", sent.url === "https://api.meta.ai/v1/chat/completions", sent.url);
  check("...as a Bearer token", (sent.init.headers as Record<string, string>)["authorization"] === "Bearer k-secret");
  check("...streaming", body.stream === true);
  // WITHOUT THIS, §10's FIGURE IS UNKNOWN ON EVERY NON-ANTHROPIC TURN, FOREVER.
  check("...and asking for usage", body.stream_options?.include_usage === true, JSON.stringify(body.stream_options));
  check("...with the ceiling this call sends", body.max_tokens === 900);
  // THE SYSTEM PROMPT AS A MESSAGE, which is this API's shape. `prompt.ts` still owns every word.
  check("the system prompt leads the messages",
    body.messages?.[0]?.role === "system" && body.messages[0].content === "the rules",
    JSON.stringify(body.messages?.[0]));
  check("...then the conversation", body.messages?.[1]?.content === "a question");
  check("the model is named", body.model === "muse-spark-1.3");
}

// --- the stream -------------------------------------------------------------------------------

console.log("\nthe stream");
{
  const frames = [
    'data: {"choices":[{"delta":{"content":"It "}}]}\n\n',
    // A FRAME SPLIT ACROSS TWO CHUNKS, which is the ordinary case on a real connection and the one
    // that loses a token at every buffer edge if the remainder is not kept.
    'data: {"choices":[{"delta":{"content":"timed ',
    'out."}}]}\n\ndata: {"usage":{"prompt_tokens":1200,"completion_tokens":40,"prompt_tokens_details":{"cached_tokens":200}}}\n\n',
    "data: [DONE]\n\n",
  ];
  let text = "";
  // TYPED EXPLICITLY AND READ THROUGH A LOCAL, because TypeScript narrows a `let x = null` to
  // `never` inside a closure it cannot see run — the assignment happens in a callback, so the
  // declared type is the only thing that says what the variable can hold.
  let usage: OpenAiUsage | null = null;
  const { fn } = fakeFetch(frames);
  await withFetch(fn, async () => {
    await streamOpenAiChat(
      {
        provider: "openai", model: "gpt-5.6-luna", apiKey: "k",
        system: "s", messages: [{ role: "user", content: "q" }], maxTokens: 900,
      },
      { onDelta: (t) => { text += t; }, onUsage: (u) => { usage = u; } },
    );
  });
  check("deltas arrive in order", text === "It timed out.", text);
  check("...including one split across two chunks", text.includes("timed out"), text);
  check("the usage is reported", usage !== null);
  const u = usage as OpenAiUsage | null;
  // THE SPLIT THAT MATTERS FOR MONEY. `prompt_tokens` is 1200 INCLUDING 200 cached, so the uncached
  // slot is 1000 — handing over 1200 would charge the cache reads at the full input rate.
  check("uncached input excludes the cached tokens", u?.input === 1000, String(u?.input));
  check("...and the cached ones are reported apart", u?.cacheRead === 200, String(u?.cacheRead));
  check("output is output", u?.output === 40, String(u?.output));
  // NO CACHE-WRITE FIGURE ON THIS SHAPE, so it is 0 rather than a guess — these APIs cache
  // implicitly and report no creation count.
  check("no cache-write count is invented", u?.cacheWrite === 0, String(u?.cacheWrite));
  check("the model travels with the counts", u?.model === "gpt-5.6-luna", String(u?.model));
}

console.log("\n§16 — a provider returning malformed JSON");
{
  const { fn } = fakeFetch([
    'data: {"choices":[{"delta":{"content":"partial "}}]}\n\n',
    "data: {not json at all\n\n",
    'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  let text = "";
  await withFetch(fn, async () => {
    await streamOpenAiChat(
      { provider: "openai", model: "gpt-5.6-luna", apiKey: "k", system: "s", messages: [{ role: "user", content: "q" }], maxTokens: 900 },
      { onDelta: (t) => { text += t; }, onUsage: () => {} },
    );
  });
  // ONE BAD FRAME COSTS ONE FRAME. Taking down a finished answer because a frame was mangled would
  // be the worse outcome — and §7.3's partial-output rule points the same way.
  check("a malformed frame is skipped, not fatal", text === "partial answer", text);
}

console.log("\na failure carries what §7 classifies on");
{
  const { fn } = fakeFetch(['{"error":{"message":"rate limit"}}'], 429, { "retry-after": "13" });
  let thrown: unknown = null;
  await withFetch(fn, async () => {
    await streamOpenAiChat(
      { provider: "openai", model: "gpt-5.6-luna", apiKey: "k", system: "s", messages: [{ role: "user", content: "q" }], maxTokens: 900 },
      { onDelta: () => {}, onUsage: () => {} },
    ).catch((e) => { thrown = e; });
  });
  check("it throws", thrown !== null);
  // THE STATUS AND THE HEADER TRAVEL AS FIELDS, because §7's classifier reads fields rather than
  // prose: a 429 without its `retry-after` is a countdown with no number.
  check("...carrying the status", (thrown as { status?: number })?.status === 429, String((thrown as { status?: number })?.status));
  check("...and the retry-after header",
    (thrown as { headers?: Record<string, string> })?.headers?.["retry-after"] === "13",
    JSON.stringify((thrown as { headers?: unknown })?.headers));
  // AND THE BODY IS BOUNDED, because it goes into a turn somebody is reading.
  check("...and a bounded body", String((thrown as Error)?.message).length < 700);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
