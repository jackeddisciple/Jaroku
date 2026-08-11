// Run tokens: minting, scoping, expiry and revocation — the credential a sandboxed run
// authenticates its control-plane calls with.
//
//   npm run test:run-tokens

import { randomBytes } from "node:crypto";
import {
  MAX_RUN_TOKEN_TTL_S,
  mintRunToken,
  RunTokenRevocationList,
  verifyRunToken,
} from "./runTokens.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const secret = randomBytes(32);
const otherSecret = randomBytes(32);

await (async () => {
  const token = mintRunToken(secret, "run-1", "ws-1", 60);
  const result = verifyRunToken(secret, token);
  check("a freshly minted token verifies", result.ok);
  if (result.ok) {
    check("the run id round-trips", result.claims.runId === "run-1");
    check("the workspace id round-trips", result.claims.workspaceId === "ws-1");
  }
})();

await (async () => {
  const token = mintRunToken(secret, "run-1", "ws-1", 60);
  const result = verifyRunToken(otherSecret, token);
  check("a token signed with a different key is refused", !result.ok && result.reason === "bad_signature");
})();

await (async () => {
  const now = 1_000_000;
  const token = mintRunToken(secret, "run-1", "ws-1", 10, now);
  const stillValid = verifyRunToken(secret, token, now + 9_000);
  const expired = verifyRunToken(secret, token, now + 11_000);
  check("a token is valid inside its ttl", stillValid.ok);
  check("a token is refused once its ttl has passed", !expired.ok && expired.reason === "expired");
})();

await (async () => {
  const token = mintRunToken(secret, "run-1", "ws-1", 60);
  const tampered = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
  const result = verifyRunToken(secret, tampered);
  check("flipping one character of the signature is refused", !result.ok && result.reason === "bad_signature");
})();

await (async () => {
  const token = mintRunToken(secret, "run-1", "ws-1", 60);
  // Cross the run id from one token onto the workspace/expiry/signature of another. A token
  // must name exactly the run it was minted for — this is the confusion the length-prefixed,
  // position-fixed payload exists to prevent, and it should be refused on the signature, not
  // silently accepted with the wrong run id.
  const other = mintRunToken(secret, "run-2", "ws-1", 60);
  const [, wsA, expA, sigA] = token.split(".");
  const swapped = `${other.split(".")[0]}.${wsA}.${expA}.${sigA}`;
  const result = verifyRunToken(secret, swapped);
  check("splicing a different run id onto a valid signature is refused", !result.ok && result.reason === "bad_signature");
})();

for (const bad of ["", "not-a-token", "a.b.c", "a.b.c.d.e", "run-1.ws-1.notanumber.".padEnd(70, "0")]) {
  check(`malformed input ${JSON.stringify(bad.slice(0, 30))} is refused, not thrown`, !verifyRunToken(secret, bad).ok);
}

check(
  "a ttl request beyond the ceiling is clamped, not honoured",
  (() => {
    const now = 1_000_000;
    const token = mintRunToken(secret, "run-1", "ws-1", MAX_RUN_TOKEN_TTL_S * 100, now);
    const parts = token.split(".");
    const expiresAtMs = Number(parts[2]);
    return expiresAtMs - now <= MAX_RUN_TOKEN_TTL_S * 1000;
  })(),
);

await (async () => {
  const list = new RunTokenRevocationList();
  const token = mintRunToken(secret, "run-1", "ws-1", 60);
  const result = verifyRunToken(secret, token);
  check("sanity: the token verifies before revocation", result.ok);
  if (result.ok) list.revoke(result.claims.runId, result.claims.expiresAtMs);
  check("a revoked run id is reported revoked", list.isRevoked("run-1"));
  check("an unrelated run id is not", !list.isRevoked("run-2"));
})();

await (async () => {
  const list = new RunTokenRevocationList();
  list.revoke("run-1", 1_000);
  list.revoke("run-2", 5_000);
  const swept = list.sweep(2_000);
  check("sweep drops only entries past their own token expiry", swept === 1 && !list.isRevoked("run-1") && list.isRevoked("run-2"));
})();

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
