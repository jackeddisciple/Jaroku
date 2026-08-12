// Where each connector's credential comes from, and the two files that have to say so.
//
// The field is small and its consequences are not. Before it, every connector's `required_env`
// was one undifferentiated list of things a user pastes in — which was true when the only way to
// configure Gmail was to obtain a refresh token by hand. It is now false for two of the three
// connectors, and a `.env.example` that still presents `GMAIL_REFRESH_TOKEN=` as a blank to fill
// is telling somebody to go and redo, by hand and badly, the thing the Connect button just did.
//
// THE NAMES STILL APPEAR IN THE FILE, and that is the assertion people get wrong in the other
// direction. A generated project is portable — the README promises it runs standalone, and a test
// in `test:acceptance` proves it — so a copy running outside Jaroku has no connection to ask and
// needs those names documented. What changes is what the file SAYS about them, not whether it
// mentions them.
//
//   npm run test:connector-auth

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  authModeOf,
  connectionSuppliedEnv,
  isConnectorAuth,
  loadConnectors,
  requiredEnv,
  resolveSelected,
  userSuppliedEnv,
} from "./connectors.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const RUNTIME = join(fileURLToPath(new URL("../..", import.meta.url)), "runtime");
const all = loadConnectors(RUNTIME);

console.log("\nevery connector declares where its credential comes from");
check(all.length > 0, `the catalog loaded (${all.length} connectors)`);
for (const c of all) {
  check(isConnectorAuth(c.auth), `${c.id} declares a valid auth mode`, String(c.auth));
}
check(authModeOf(all.find((c) => c.id === "gmail")!) === "oauth", "gmail is oauth — Jaroku owns the app");
check(authModeOf(all.find((c) => c.id === "slack")!) === "oauth", "slack is oauth");
check(
  authModeOf(all.find((c) => c.id === "postgres")!) === "user_secret",
  "postgres is a user_secret — the connection string is the user's, and nothing else could supply it",
);

console.log("\na catalog written before the field existed behaves as it did");
check(
  authModeOf({ ...all[0]!, auth: undefined }) === "user_secret",
  "an absent auth mode reads as user_secret, which is what every connector was",
);
check(!isConnectorAuth("both"), "and an unrecognised value is not quietly accepted");

console.log("\nthe two lists .env.example is built from");
{
  const selected = resolveSelected(all, ["gmail", "postgres"]);
  const supplied = userSuppliedEnv(selected);
  const connected = connectionSuppliedEnv(selected);

  check(supplied.includes("DATABASE_URL"), "postgres's key is one the user fills in");
  check(!connected.includes("DATABASE_URL"), "...and is not one a connection fills");
  check(
    connected.includes("GMAIL_REFRESH_TOKEN") && connected.includes("GMAIL_CLIENT_SECRET"),
    "gmail's keys are filled by the connection",
  );
  check(!supplied.some((k) => k.startsWith("GMAIL_")), "...and are not presented as blanks to paste into");

  // The union is unchanged, which is the portability half. Nothing has been dropped from what a
  // standalone copy of the project is told it needs.
  const union = [...supplied, ...connected].sort();
  check(
    union.join(",") === requiredEnv(selected).slice().sort().join(","),
    "and between them the two lists are still exactly required_env — nothing was dropped",
    union.join(","),
  );
}

console.log("\nan agent with no connectors");
{
  const none = resolveSelected(all, []);
  check(userSuppliedEnv(none).length === 0, "asks the user for nothing");
  check(connectionSuppliedEnv(none).length === 0, "...and needs no connection");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
