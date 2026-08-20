// What a `jaroku://` URL is allowed to say.
//
// Every URL this parser sees came from outside the application: any program on the machine can
// open one, and so can a web page somebody clicked. So the interesting half of this suite is the
// refusals, and the assertion that matters most is the one about a link that ALMOST parses —
// `jaroku://authorize/...` is not `jaroku://auth/...`, and a parser that matched on a prefix
// would hand a handler somebody else's word.

import { parseDeepLink, onDeepLink } from "./deepLink.ts";

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

console.log("\nthe hand-crafted link this feature is verified with");
{
  const link = parseDeepLink("jaroku://test");
  check("jaroku://test parses", link !== null);
  check("...as the test action", link?.action === "test");
  check("...with no path segments", link?.path.length === 0);
  check("...and no parameters", Object.keys(link?.params ?? { a: "" }).length === 0);
  check("...carrying the URL exactly as it arrived", link?.raw === "jaroku://test");
}

console.log("\nthe shapes a real link takes");
{
  const link = parseDeepLink("jaroku://auth/callback?code=abc&state=xyz");
  check("the action comes from the host when the URL has slashes", link?.action === "auth");
  check("...and the rest of the path is segments, not a string", link?.path.join(",") === "callback");
  check("...with the query flattened", link?.params.code === "abc" && link?.params.state === "xyz");
}
{
  // Some mail clients rewrite `jaroku://auth` into the slashless form. Both have to work, or a
  // magic link is one that fails for a subset of people with no pattern anybody can see.
  const link = parseDeepLink("jaroku:auth/callback?code=abc");
  check("a slashless jaroku:auth/... parses the same way", link?.action === "auth");
  check("...with the same path", link?.path.join(",") === "callback");
}
{
  const link = parseDeepLink("jaroku://thread/abc/step/4");
  check("a deeper path keeps every segment in order", link?.path.join(",") === "abc,step,4");
}
{
  const link = parseDeepLink("jaroku://agent/my%20agent");
  check("a percent-encoded segment is decoded once", link?.path[0] === "my agent");
}
{
  const link = parseDeepLink("jaroku://auth/callback?token=first&token=second");
  check(
    "a repeated parameter keeps the FIRST value, never the last",
    link?.params.token === "first",
  );
}

console.log("\nwhat is refused, which is everything else");
check("another application's scheme is refused", parseDeepLink("myapp://test") === null);
check("an http URL is refused", parseDeepLink("http://localhost/test") === null);
check(
  "a link that only starts like ours is refused rather than prefix-matched",
  parseDeepLink("jaroku://authorize/callback") === null,
);
check("an unknown action is refused", parseDeepLink("jaroku://drop-everything") === null);
check("a jaroku URL with no action at all is refused", parseDeepLink("jaroku://") === null);
check("a string that is not a URL is refused", parseDeepLink("jaroku") === null);
check("an empty string is refused", parseDeepLink("") === null);
check("a value that is not a string is refused", parseDeepLink({ url: "jaroku://test" }) === null);
check("null is refused", parseDeepLink(null) === null);
{
  // `decodeURIComponent` throws on a lone `%`. Before the guard, one character reached a handler
  // as an exception from inside an event callback, where nothing is watching for one.
  let threw = false;
  try {
    parseDeepLink("jaroku://test/%");
  } catch {
    threw = true;
  }
  check("a malformed escape does not throw out of the parser", !threw);
}
{
  // Three spellings, because `new URL` treats them differently and only the first is handled for
  // us. The authority form is normalised before this parser sees it; the slashless form has an
  // opaque path that is kept verbatim; and `..%2f` survives normalisation encoded and becomes a
  // separator only after the decode. Each was checked against the platform parser rather than
  // assumed, and the last two are the reason there is an explicit refusal at all.
  check(
    "an authority-form traversal is resolved away before it reaches a segment",
    parseDeepLink("jaroku://test/../../etc/passwd")?.path.join(",") === "etc,passwd",
  );
  check(
    "a slashless traversal is refused, because that path is opaque and keeps its dots",
    parseDeepLink("jaroku:auth/../x") === null,
  );
  check(
    "an encoded separator is refused, because it becomes one only after the decode",
    parseDeepLink("jaroku://auth/..%2fx") === null,
  );
}
{
  // `Object.create(null)` rather than `{}` for the parameter bag. With a plain object a link
  // carrying `?__proto__=...` reaches a prototype rather than a key, which is the same defect
  // v0.2.1 fixed for a tool named `__proto__` in the MCP registry.
  const link = parseDeepLink("jaroku://test?__proto__=polluted");
  check("a __proto__ parameter is a key rather than a prototype", link?.params.__proto__ === "polluted");
  check("...and nothing else was touched by it", ({} as Record<string, unknown>).polluted === undefined);
}

console.log("\noutside a host, the feature is absent rather than broken");
{
  let called = false;
  const stop = onDeepLink(() => {
    called = true;
  });
  check("subscribing in a browser returns an unsubscribe rather than throwing", typeof stop === "function");
  check("...which can be called", (stop(), true));
  check("...and nothing was ever delivered", !called);
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
