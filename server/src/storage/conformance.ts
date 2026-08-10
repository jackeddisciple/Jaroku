// One suite, run against every object store.
//
// The same argument db/conformance.ts makes, for the same reason. An interface with two
// implementations is a promise that the application cannot tell which one it got, and that
// promise is worth exactly as much as the cases somebody thought to check. The ways a
// filesystem and S3 differ are almost all quiet: one has directories and the other has a flat
// keyspace that merely looks like it has them; one's `list` is a tree walk and the other's is a
// byte-prefix scan with pagination; one overwrites in place and the other replaces an object;
// one reports an mtime with second granularity and the other returns an ETag. None of those
// throw at the boundary. They surface as generation working locally and losing a file hosted.
//
// So the suite lives apart from either implementation and both must pass it identically. A
// third store added later has a definition of done.
//
// WHAT IS DELIBERATELY NOT ASSERTED: that two stores produce the same etag for the same bytes.
// They do not — S3 returns an MD5 and the local store a SHA-256 — and ObjectMeta.etag promises
// only an opaque marker that is stable within one store. Asserting more would be asserting a
// property the interface does not have, which is how a conformance suite starts constraining
// the implementations instead of describing them.

import { randomUUID } from "node:crypto";
import { agentStagingKey, agentVersionKey, agentVersionPrefix, workspacePrefix } from "./keys.ts";
import { ObjectNotFound, type ObjectStore } from "./objectStore.ts";

export interface ConformanceResult {
  failures: number;
}

/**
 * Run the suite against an open store. The caller owns constructing it, because "open an object
 * store" is the one thing that cannot be written once for both.
 *
 * Everything is written under two fresh workspace uuids, so the suite can be pointed at a
 * shared bucket without two runs colliding, and so a crashed run leaves nothing that breaks the
 * next one.
 */
export async function runObjectConformance(label: string, store: ObjectStore): Promise<ConformanceResult> {
  let failures = 0;
  const check = (ok: boolean, msg: string): void => {
    if (ok) console.log(`  ok   ${msg}`);
    else {
      failures++;
      console.log(`  FAIL ${msg}`);
    }
  };

  const WS = randomUUID();
  const OTHER = randomUUID();
  const AGENT = randomUUID();
  console.log(`\n${label}`);

  check(store.kind === "fs" || store.kind === "s3", `reports a kind (${store.kind})`);

  // --- the round trip ----------------------------------------------------------------
  const key = agentVersionKey(WS, AGENT, 1, "agent.py");
  const source = 'def build_graph(llm):\n    return "π ≈ 3.14159"\n';
  const put = await store.put(key, source, { contentType: "text/x-python" });
  check(put.key === key, "put reports the key it wrote");
  check(put.bytes === Buffer.byteLength(source, "utf8"), "put reports the byte length, not the character count");
  check(put.etag.length > 0, "put reports an etag");

  const fetched = await store.get(key);
  check(fetched.toString("utf8") === source, "the bytes come back identical, multi-byte characters included");

  // A binary body, because "everything is UTF-8" is an assumption that holds until an eval
  // export is gzipped or a version manifest carries a compiled asset.
  const binary = Buffer.from([0x00, 0xff, 0x10, 0x00, 0x7f, 0x80]);
  const binKey = agentVersionKey(WS, AGENT, 1, "assets/blob.bin");
  await store.put(binKey, binary);
  check((await store.get(binKey)).equals(binary), "a body with NUL and high bytes survives");

  // --- head and absence --------------------------------------------------------------
  const head = await store.head(key);
  check(head !== null && head.bytes === put.bytes, "head answers for a key that exists");
  const missing = agentVersionKey(WS, AGENT, 9, "gone.py");
  check((await store.head(missing)) === null, "head answers null for one that does not, rather than throwing");

  let notFound = false;
  try {
    await store.get(missing);
  } catch (err) {
    notFound = err instanceof ObjectNotFound;
  }
  check(notFound, "get throws ObjectNotFound for an absent key, so absent and broken are different answers");

  // --- overwrite ---------------------------------------------------------------------
  const changed = "def build_graph(llm):\n    pass\n";
  const rewritten = await store.put(key, changed);
  check((await store.get(key)).toString("utf8") === changed, "a second put replaces the object");
  check(rewritten.etag !== put.etag, "...and the etag changes with the content");
  const again = await store.put(key, changed);
  check(again.etag === rewritten.etag, "...while identical content keeps the same etag");

  // --- listing -----------------------------------------------------------------------
  await store.put(agentVersionKey(WS, AGENT, 1, "tools/notes.py"), "x = 1\n");
  await store.put(agentVersionKey(WS, AGENT, 2, "agent.py"), "y = 2\n");
  const v1 = await store.list(agentVersionPrefix(WS, AGENT, 1));
  check(v1.length === 3, `list returns one version's objects (${v1.length} of 3)`);
  check(
    v1.map((o) => o.key).join("|") === [...v1].map((o) => o.key).sort().join("|"),
    "...sorted by key, on both implementations",
  );
  check(v1.every((o) => o.bytes > 0), "...with a byte length for each");
  check(
    (await store.list(agentVersionPrefix(WS, AGENT, 3))).length === 0,
    "a prefix with nothing under it lists empty rather than failing",
  );

  // The byte-prefix property. A filesystem's instinct is a path component and S3's is bytes,
  // and every caller in this codebase depends on the second — hence the trailing slash rule.
  await store.put(agentVersionKey(WS, AGENT, 10, "agent.py"), "z = 3\n");
  const loose = await store.list(`ws/${WS}/agents/${AGENT}/v1`);
  check(loose.length === 4, "a prefix is bytes, not a path component: v1 also matches v10");

  // Enough objects to cross the fixture's page size, so the continuation-token path is real
  // rather than theoretically supported.
  const staging = randomUUID();
  for (let i = 0; i < 12; i++) {
    await store.put(agentStagingKey(WS, AGENT, staging, `part_${String(i).padStart(2, "0")}.py`), `n = ${i}\n`);
  }
  const paged = await store.list(`ws/${WS}/agents/${AGENT}/staging/${staging}/`);
  check(paged.length === 12, `a listing longer than one page returns every key (${paged.length} of 12)`);

  // --- copy --------------------------------------------------------------------------
  const copyTarget = agentVersionKey(WS, AGENT, 3, "agent.py");
  await store.copy(key, copyTarget);
  check((await store.get(copyTarget)).equals(await store.get(key)), "copy produces the same bytes");
  await store.put(copyTarget, "diverged\n");
  check(
    (await store.get(key)).toString("utf8") === changed,
    "...as an independent object, so writing the copy never touches the source",
  );

  let copyMissing = false;
  try {
    await store.copy(missing, agentVersionKey(WS, AGENT, 4, "x.py"));
  } catch (err) {
    copyMissing = err instanceof ObjectNotFound;
  }
  check(copyMissing, "copying an absent source is ObjectNotFound, not a silently empty object");

  // --- delete ------------------------------------------------------------------------
  await store.delete(copyTarget);
  check((await store.head(copyTarget)) === null, "delete removes the object");
  await store.delete(copyTarget);
  check(true, "...and deleting it again is not an error");

  // Three: agent.py, assets/blob.bin and tools/notes.py. NOT the v10 object the byte-prefix
  // check wrote — `deletePrefix` is given the trailing slash, so it means the version and not
  // every version whose number starts with a 1. That distinction is the whole reason the
  // loose-prefix assertion above exists.
  const removed = await store.deletePrefix(agentVersionPrefix(WS, AGENT, 1));
  check(removed === 3, `deletePrefix reports how many it removed (${removed} of 3)`);
  check((await store.list(agentVersionPrefix(WS, AGENT, 1))).length === 0, "...and the prefix is empty afterwards");
  check((await store.head(agentVersionKey(WS, AGENT, 2, "agent.py"))) !== null, "...while a neighbouring version is untouched");
  check((await store.head(agentVersionKey(WS, AGENT, 10, "agent.py"))) !== null, "...and so is the version whose number merely starts the same");

  // --- one workspace cannot see another's ---------------------------------------------
  await store.put(agentVersionKey(OTHER, AGENT, 1, "agent.py"), "another tenant\n");
  const mine = await store.list(workspacePrefix(WS));
  check(
    mine.length > 0 && mine.every((o) => o.key.startsWith(`ws/${WS}/`)),
    "a workspace prefix enumerates only that workspace",
  );
  check(
    (await store.list(workspacePrefix(OTHER))).length === 1,
    "...even when both used the same agent uuid and the same file path",
  );

  // --- presigned URLs ------------------------------------------------------------------
  const signed = await store.presignGet(agentVersionKey(WS, AGENT, 2, "agent.py"), 300);
  check(signed.url.length > 0 && Date.parse(signed.expiresAt) > Date.now(), "presignGet mints a URL with a future expiry");
  const signedPut = await store.presignPut(agentVersionKey(WS, AGENT, 5, "new.py"), 300);
  check(signedPut.url !== signed.url, "presignPut is a different URL — a read grant is not a write grant");

  // --- clean up ------------------------------------------------------------------------
  await store.deletePrefix(workspacePrefix(WS));
  await store.deletePrefix(workspacePrefix(OTHER));
  check((await store.list(workspacePrefix(WS))).length === 0, "a workspace's objects can all be removed at once");

  return { failures };
}
