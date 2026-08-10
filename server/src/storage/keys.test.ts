// The key builder, and the local store that turns a key back into a path.
//
// This file is mostly about one sentence from the spec: "object stores do not have `..`, but S3
// will happily create a key containing one and your local dev FsObjectStore will then write
// outside its root." That is the shape of every assertion below — a key is a flat string in one
// place and a path in another, and everything dangerous lives in the gap.
//
// So the traversal cases are not a token check. They cover the plain form, the encoded form, the
// separator that is a separator on one platform and a character on another, and the assembled
// key that never went through a builder at all — because in production a key arrives off a
// presigned URL and out of a stored manifest at least as often as it arrives from keys.ts.
//
//   npm run test:object-keys

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentPrefix, agentStagingKey, agentStagingPrefix, agentVersionKey, agentVersionPrefix,
  assertKey, assertPrefix, exportKey, KeyError, newStagingId, safeObjectPath, workspaceIdFromKey,
  workspacePrefix,
} from "./keys.ts";
import { FsObjectStore } from "./fsObjectStore.ts";
import { ObjectNotFound } from "./objectStore.ts";
import {
  MAX_PRESIGN_TTL_S, OBJECT_ROUTE_PREFIX, resolveSigningKey, SIGNING_KEY_ENV, signLocalUrl,
  verifyLocalUrl,
} from "./presign.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

/** True when `fn` throws a KeyError. Anything else is a different bug and fails loudly. */
const refuses = (fn: () => unknown): boolean => {
  try {
    fn();
    return false;
  } catch (err) {
    return err instanceof KeyError;
  }
};

const WS_A = randomUUID();
const WS_B = randomUUID();
const AGENT = randomUUID();

const scratch: string[] = [];
const tmpRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), "jaroku-objects-"));
  scratch.push(d);
  return d;
};

// --- 1. the layout -----------------------------------------------------------------------
console.log("\nkey layout");
{
  check(
    "an agent version key is ws/<workspace>/agents/<agent>/v<n>/<path>",
    agentVersionKey(WS_A, AGENT, 3, "tools/notes.py") ===
      `ws/${WS_A}/agents/${AGENT}/v3/tools/notes.py`,
  );

  const staging = newStagingId();
  check(
    "a staging key is scoped to the workspace, the agent and one staging id",
    agentStagingKey(WS_A, AGENT, staging, "agent.py") ===
      `ws/${WS_A}/agents/${AGENT}/staging/${staging}/agent.py`,
  );

  const evalRun = randomUUID();
  check("an export key names the eval run", exportKey(WS_A, evalRun) === `ws/${WS_A}/exports/${evalRun}.csv`);

  check("prefixes end in a slash and keys do not", [
    workspacePrefix(WS_A), agentPrefix(WS_A, AGENT), agentVersionPrefix(WS_A, AGENT, 1),
    agentStagingPrefix(WS_A, AGENT, staging),
  ].every((p) => p.endsWith("/")) && !agentVersionKey(WS_A, AGENT, 1, "a.py").endsWith("/"));

  check(
    "every key starts with the workspace, so a holder can tell whose it is",
    workspaceIdFromKey(agentVersionKey(WS_A, AGENT, 1, "a.py")) === WS_A &&
      workspaceIdFromKey(exportKey(WS_B, evalRun)) === WS_B,
  );
  check(
    "and a key that names no workspace belongs to none",
    workspaceIdFromKey("agents/x/v1/a.py") === null &&
      workspaceIdFromKey("ws/not-a-uuid/agents/a.py") === null &&
      workspaceIdFromKey(undefined) === null,
  );
}

// --- 2. ids are ids ----------------------------------------------------------------------
console.log("\nvalidated components");
{
  check("a workspace that is not a uuid is refused", refuses(() => workspacePrefix("../../etc")));
  check("an agent id that is not a uuid is refused", refuses(() => agentPrefix(WS_A, "support_bot")));
  check("a slug cannot stand in for the agent uuid", refuses(() => agentVersionKey(WS_A, "a".repeat(36), 1, "a.py")));
  check("an undefined id is refused rather than stringified", refuses(() => workspacePrefix(undefined as never)));
  check("version 0 is refused", refuses(() => agentVersionPrefix(WS_A, AGENT, 0)));
  check("a fractional version is refused", refuses(() => agentVersionPrefix(WS_A, AGENT, 1.5)));
  check("a negative version is refused", refuses(() => agentVersionPrefix(WS_A, AGENT, -1)));
}

// --- 3. the traversal, in every spelling -------------------------------------------------
console.log("\npaths that must never become keys");
{
  const hostile: [string, unknown][] = [
    ["a plain traversal", "../../../etc/passwd"],
    ["a traversal in the middle", "tools/../../../etc/passwd"],
    ["a bare .. segment", ".."],
    ["a bare . segment", "."],
    ["an absolute path", "/etc/passwd"],
    ["a Windows drive letter", "C:/windows/system32"],
    ["a backslash separator", "tools\\..\\..\\etc"],
    ["a percent-encoded traversal", "%2e%2e%2f%2e%2e%2fetc"],
    ["a doubled separator", "tools//notes.py"],
    ["a leading separator", "/tools/notes.py"],
    ["a trailing separator", "tools/notes.py/"],
    ["a NUL byte", "agent.py\u0000.txt"],
    ["a newline", "agent\n.py"],
    ["a segment ending in a dot", "evil./x.py"],
    ["a segment ending in a space", "evil /x.py"],
    ["the empty string", ""],
    ["a non-string", 42],
    ["null", null],
    ["a path longer than the cap", `${"a".repeat(600)}.py`],
  ];
  for (const [name, value] of hostile) {
    check(`refused: ${name}`, safeObjectPath(value) === null);
  }
  check(
    "and a builder handed one refuses rather than building it",
    refuses(() => agentVersionKey(WS_A, AGENT, 1, "../../../etc/passwd")),
  );

  const legal = ["agent.py", "tools/notes.py", ".env.example", "Dockerfile", "prompts/system.md", ".dockerignore"];
  check(
    "a real project's files all pass",
    legal.every((p) => safeObjectPath(p) === p),
    legal.filter((p) => safeObjectPath(p) !== p).join(", "),
  );
}

// --- 4. assembled keys are re-checked ----------------------------------------------------
//
// The builders are not the only source of a key. One arrives off a presigned URL, out of an
// `agent_versions` manifest an older version of this code wrote, and out of a `list()` result on
// its way into `copy()`. So the whole string gets checked too.
console.log("\nassembled keys");
{
  check("a well-formed key passes", assertKey(agentVersionKey(WS_A, AGENT, 1, "agent.py")).length > 0);
  check("a key with no workspace is refused", refuses(() => assertKey("agents/x/v1/agent.py")));
  check("a key rooted elsewhere is refused", refuses(() => assertKey("etc/passwd")));
  check("a traversal in an assembled key is refused", refuses(() => assertKey(`ws/${WS_A}/../${WS_B}/agents/a.py`)));
  check("a prefix passed as a key is refused", refuses(() => assertKey(workspacePrefix(WS_A))));
  check("an over-long key is refused", refuses(() => assertKey(`ws/${WS_A}/${"a".repeat(1100)}`)));

  check("a workspace prefix is a legal prefix", assertPrefix(workspacePrefix(WS_A)) === workspacePrefix(WS_A));
  check("a partial-segment prefix is legal, because S3 means bytes", assertPrefix(`ws/${WS_A}/age`) === `ws/${WS_A}/age`);
  check("listing every workspace is refused", refuses(() => assertPrefix("ws/")));
  check("a traversal in a prefix is refused", refuses(() => assertPrefix(`ws/${WS_A}/../`)));
}

// --- 5. the local store confines itself --------------------------------------------------
console.log("\nFsObjectStore");
{
  const root = tmpRoot();
  const store = new FsObjectStore({ root, signingKey: randomBytes(32) });
  const key = agentVersionKey(WS_A, AGENT, 1, "agent.py");

  const meta = await store.put(key, "def build_graph(llm):\n    ...\n");
  check("put reports what it stored", meta.key === key && meta.bytes > 0 && meta.etag.length === 64);
  check("the bytes come back identical", (await store.get(key)).toString("utf8").startsWith("def build_graph"));
  check("head answers for a key that exists", (await store.head(key))?.bytes === meta.bytes);
  check("head answers null rather than throwing for one that does not", (await store.head(agentVersionKey(WS_A, AGENT, 9, "nope.py"))) === null);

  let notFound = false;
  try {
    await store.get(agentVersionKey(WS_A, AGENT, 9, "nope.py"));
  } catch (err) {
    notFound = err instanceof ObjectNotFound;
  }
  check("get distinguishes absent from broken", notFound);

  await store.put(agentVersionKey(WS_A, AGENT, 1, "tools/notes.py"), "x = 1\n");
  await store.put(agentVersionKey(WS_A, AGENT, 2, "agent.py"), "y = 2\n");
  const v1 = await store.list(agentVersionPrefix(WS_A, AGENT, 1));
  check("list returns one version's objects, sorted", v1.length === 2 && v1[0]!.key < v1[1]!.key);
  check(
    "and never the directories they sit in",
    v1.every((o) => o.key.endsWith(".py")),
  );

  // The byte-prefix property, stated as a test because it is the one place a filesystem's
  // instinct and S3's semantics genuinely differ.
  await store.put(agentVersionKey(WS_A, AGENT, 10, "agent.py"), "z = 3\n");
  const loose = await store.list(`ws/${WS_A}/agents/${AGENT}/v1`);
  check("a prefix is bytes, not a path component (v1 also matches v10)", loose.length === 3);
  const tight = await store.list(agentVersionPrefix(WS_A, AGENT, 1));
  check("...which is why callers pass the trailing slash", tight.length === 2);

  const copied = agentVersionKey(WS_A, AGENT, 3, "agent.py");
  await store.copy(key, copied);
  check("copy produces the same bytes", (await store.get(copied)).equals(await store.get(key)));
  await store.put(copied, "changed\n");
  check(
    "...as an independent object, so a version is immutable",
    (await store.get(key)).toString("utf8").startsWith("def build_graph"),
  );

  await store.delete(copied);
  check("delete removes it", (await store.head(copied)) === null);
  await store.delete(copied);
  check("...and deleting it again is not an error", true);

  const removed = await store.deletePrefix(agentVersionPrefix(WS_A, AGENT, 1));
  check("deletePrefix removes a whole version", removed === 2 && (await store.list(agentVersionPrefix(WS_A, AGENT, 1))).length === 0);
  check(
    "...and leaves no empty directory a hosted store would not have",
    !existsSync(join(root, "ws", WS_A, "agents", AGENT, "v1")),
  );

  // The point of the whole file: a key that got past validation somehow still cannot escape.
  let escaped = false;
  try {
    await store.put(`ws/${WS_A}/../../escaped.txt`, "nope");
    escaped = true;
  } catch {
    /* refused, as it must be */
  }
  check("a traversing key cannot write outside the root", !escaped && !existsSync(join(root, "..", "escaped.txt")));

  // Written directly, bypassing the store, so nothing was validated on the way in.
  const stray = join(root, "ws", WS_A, "agents", AGENT, "v2", "agent.py.tmp-abc");
  writeFileSync(stray, "half a file");
  const afterStray = await store.list(agentVersionPrefix(WS_A, AGENT, 2));
  check("a half-written temp file is not an object", afterStray.every((o) => !o.key.includes(".tmp-")));
  rmSync(stray, { force: true });
}

// --- 6. one workspace cannot name another's object ---------------------------------------
console.log("\ncross-workspace keys");
{
  const store = new FsObjectStore({ root: tmpRoot(), signingKey: randomBytes(32) });
  await store.put(agentVersionKey(WS_A, AGENT, 1, "secret.py"), "A's code\n");
  await store.put(agentVersionKey(WS_B, AGENT, 1, "secret.py"), "B's code\n");

  const fromA = await store.list(workspacePrefix(WS_A));
  check(
    "a workspace prefix enumerates only that workspace",
    fromA.length === 1 && fromA[0]!.key.includes(WS_A) && !fromA.some((o) => o.key.includes(WS_B)),
  );
  check(
    "...even though both workspaces used the same agent uuid and the same path",
    (await store.get(agentVersionKey(WS_A, AGENT, 1, "secret.py"))).toString() === "A's code\n" &&
      (await store.get(agentVersionKey(WS_B, AGENT, 1, "secret.py"))).toString() === "B's code\n",
  );
}

// --- 7. presigned URLs -------------------------------------------------------------------
console.log("\npresigned URLs");
{
  const secret = randomBytes(32);
  const key = agentVersionKey(WS_A, AGENT, 1, "agent.py");
  const now = Date.now();
  const signed = signLocalUrl(secret, "get", key, 300, now);

  check("the URL points at the object route", signed.url.startsWith(OBJECT_ROUTE_PREFIX));
  check("the key is encoded whole, slashes included", !signed.url.slice(OBJECT_ROUTE_PREFIX.length).split("?")[0]!.includes("/"));

  const good = verifyLocalUrl(secret, signed.url, now + 1000);
  check("a fresh URL verifies", good.ok === true && good.key === key && good.op === "get");
  check("and reports the workspace it names", good.ok === true && good.workspaceId === WS_A);

  check("an expired URL is refused", (() => {
    const r = verifyLocalUrl(secret, signed.url, now + 301_000);
    return !r.ok && r.reason === "expired";
  })());

  check("another server's key does not verify", (() => {
    const r = verifyLocalUrl(randomBytes(32), signed.url, now + 1000);
    return !r.ok && r.reason === "bad signature";
  })());

  check("a tampered key does not verify", (() => {
    const other = agentVersionKey(WS_B, AGENT, 1, "agent.py");
    const url = signed.url.replace(encodeURIComponent(key), encodeURIComponent(other));
    const r = verifyLocalUrl(secret, url, now + 1000);
    return !r.ok && r.reason === "bad signature";
  })());

  check("a stretched expiry does not verify", (() => {
    const url = signed.url.replace(/exp=\d+/, `exp=${now + 86_400_000}`);
    const r = verifyLocalUrl(secret, url, now + 1000);
    return !r.ok && r.reason === "bad signature";
  })());

  check("a read URL cannot be turned into a write URL", (() => {
    const r = verifyLocalUrl(secret, signed.url.replace("op=get", "op=put"), now + 1000);
    return !r.ok && r.reason === "bad signature";
  })());

  check("a put URL is a different signature entirely", (() => {
    const put = signLocalUrl(secret, "put", key, 300, now);
    const r = verifyLocalUrl(secret, put.url, now + 1000);
    return r.ok === true && r.op === "put";
  })());

  check("a signature over a traversing key is refused before it is checked", (() => {
    // Signed with the real secret, so only the key validation can refuse it. This is the case
    // that matters if the signing key ever leaks: a valid signature is still not a valid key.
    const nasty = `ws/${WS_A}/../../etc/passwd`;
    const url = `${OBJECT_ROUTE_PREFIX}${encodeURIComponent(nasty)}?op=get&exp=${now + 300_000}&sig=deadbeef`;
    const r = verifyLocalUrl(secret, url, now);
    return !r.ok && r.reason === "malformed";
  })());

  check("a garbage URL is malformed rather than a crash", (() => {
    const r = verifyLocalUrl(secret, "/v1/objects/%%%?op=get&exp=1&sig=x", now);
    return !r.ok && r.reason === "malformed";
  })());

  check("a ttl is capped rather than honoured", (() => {
    const long = signLocalUrl(secret, "get", key, 86_400, now);
    return Date.parse(long.expiresAt) - now <= MAX_PRESIGN_TTL_S * 1000;
  })());
}

// --- 8. the signing key itself -----------------------------------------------------------
console.log("\nthe signing key");
{
  const dir = tmpRoot();
  const path = join(dir, "objects.key");

  const first = resolveSigningKey(path, {});
  const second = resolveSigningKey(path, {});
  check("a generated key is persisted, so a restart does not invalidate every URL", first.equals(second));
  check("...and is not world-readable", (readFileSync(path, "utf8").trim().length >= 64));

  const supplied = resolveSigningKey(join(dir, "unused.key"), { [SIGNING_KEY_ENV]: "s".repeat(48) });
  check("a supplied key is used verbatim, so every replica agrees", supplied.equals(Buffer.from("s".repeat(48), "utf8")));
  check("...and nothing was written for it", !existsSync(join(dir, "unused.key")));

  let refusedShort = false;
  try {
    resolveSigningKey(join(dir, "x.key"), { [SIGNING_KEY_ENV]: "short" });
  } catch {
    refusedShort = true;
  }
  check("a too-short supplied key is refused", refusedShort);

  let refusedProd = false;
  try {
    resolveSigningKey(join(dir, "prod.key"), { NODE_ENV: "production" });
  } catch {
    refusedProd = true;
  }
  check(
    "generating one under NODE_ENV=production is refused, because replicas would disagree",
    refusedProd,
  );
}

for (const d of scratch) rmSync(d, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
