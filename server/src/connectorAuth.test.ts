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
  configuredUserSecretConnectors,
  connectionSuppliedEnv,
  isConnectorAuth,
  loadConnectors,
  optionalEnv,
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

// THE COMPOSER DECK'S PRESENCE RULE, which had a wrong answer that looked right for two releases.
// The deck asked "does this connector have a live OAuth connection", which is not a question a
// `user_secret` connector can answer — so Postgres was invisible in the deck, read as an oversight
// nobody chased, and became three of six the moment Stripe and HTTP arrived. The consequence was
// not only a missing tile: a connector absent from the deck has no per-conversation toggle, so
// §12.10's promise that disabling one removes its tools from that conversation's dispatch could
// not be kept for any of the three.
console.log("\nwhich user_secret connectors a workspace counts as having");
{
  const none = configuredUserSecretConnectors(all, () => false);
  check(none.length === 0, "a workspace that has set up nothing has an empty deck", none.map((c) => c.connector.id).join(","));

  const every = configuredUserSecretConnectors(all, () => true);
  const userSecretIds = all.filter((c) => authModeOf(c) === "user_secret").map((c) => c.id);
  check(
    every.map((c) => c.connector.id).join(",") === userSecretIds.join(","),
    "one that has set up everything sees every user_secret connector, in catalog order",
    every.map((c) => c.connector.id).join(","),
  );
  check(every.every((c) => c.missing.length === 0), "...with nothing missing on any of them");
  check(userSecretIds.length >= 3, "and there are three of them to be wrong about", userSecretIds.join(","));

  // The OAuth ones are the other branch's business entirely. A function that returned them here
  // would put two tiles in the deck for one connector.
  check(
    !every.some((c) => authModeOf(c.connector) === "oauth"),
    "an OAuth connector never comes out of this — it is the other branch's",
  );
}

console.log("\nand one halfway through being set up is present, saying what it lacks");
{
  // Stripe needs one name; HTTP needs one. Postgres needs one. So the multi-name case is built
  // rather than found — the rule has to be right the day a connector needs two, and the day that
  // happens is not the day to discover it was written against a catalog where none did.
  const twoNames = { ...all[0]!, id: "pair", auth: "user_secret" as const, required_env: ["A_KEY", "B_KEY"] };
  const catalog = [...all, twoNames];

  const half = configuredUserSecretConnectors(catalog, (n) => n === "A_KEY");
  const pair = half.find((c) => c.connector.id === "pair");
  check(pair !== undefined, "one name set is enough to be in the deck");
  check(pair?.missing.join(",") === "B_KEY", "...and it reports exactly what is still missing", pair?.missing.join(","));

  const neither = configuredUserSecretConnectors(catalog, () => false).find((c) => c.connector.id === "pair");
  check(neither === undefined, "no names set is 'never set up', which is an option rather than a capability");

  const both = configuredUserSecretConnectors(catalog, (n) => n === "A_KEY" || n === "B_KEY").find((c) => c.connector.id === "pair");
  check(both?.missing.length === 0, "and both set is ready, with no warning to carry");
}

console.log("\nthe real catalog's own three, one at a time");
for (const id of ["postgres", "stripe", "http"]) {
  const entry = all.find((c) => c.id === id);
  check(entry !== undefined, `${id} is in the catalog`);
  if (!entry) continue;
  check(authModeOf(entry) === "user_secret", `${id} is a user_secret, so the deck's OAuth test could never see it`);
  const present = configuredUserSecretConnectors(all, (n) => entry.required_env.includes(n));
  check(
    present.length === 1 && present[0]?.connector.id === id,
    `configuring only ${id} puts exactly ${id} in the deck`,
    present.map((c) => c.connector.id).join(","),
  );
  check(present[0]?.missing.length === 0, `...ready, because its own names are the ones that were set`);
}

// THE SECOND DOOR, AND THE ONE THAT FAILS WITHOUT AN ERROR ANYWHERE. A name the Connections panel
// offers is a name a user will paste a value under. If a run does not resolve it, the vault holds
// the value, the panel reports it configured, and the sandbox authenticates with nothing — which
// is the exact shape of "a key stored under a name the runtime does not read", a failure this
// project has already paid for once. So the panel's list and the run's list must be ONE list.
console.log("\nthe optional names a run resolves are the ones the panel offers");
{
  const http = all.find((c) => c.id === "http")!;
  check(http.optional_env?.includes("HTTP_AUTH_HEADER") === true, "http declares its optional header in the catalog");
  check(!http.required_env.includes("HTTP_AUTH_HEADER"), "...and NOT in required_env, which a deploy refuses over");

  const selected = resolveSelected(all, ["http"]);
  check(optionalEnv(selected).join(",") === "HTTP_AUTH_HEADER", "so a run selecting http resolves it", optionalEnv(selected).join(","));
  check(
    !requiredEnv(selected).includes("HTTP_AUTH_HEADER"),
    "...while the required list a deploy checks stays free of it, or a deploy would refuse over an optional value",
  );

  // The panel's own list, assembled the way `connectionSnapshot` assembles it. This is the
  // assertion that would have caught the gap: the field was offered from a table in index.ts and
  // resolved from `required_env`, so the two lists were different lists.
  const offered = [...http.required_env, ...(http.optional_env ?? [])];
  const resolved = [...requiredEnv(selected), ...optionalEnv(selected)];
  check(
    offered.every((name) => resolved.includes(name)),
    "every name the panel offers is one a run resolves",
    `offered ${offered.join(",")} vs resolved ${resolved.join(",")}`,
  );
}

console.log("\nand a connector with no optional names contributes none");
{
  for (const id of ["gmail", "slack", "postgres", "stripe", "google_calendar"]) {
    const one = resolveSelected(all, [id]);
    check(optionalEnv(one).length === 0, `${id} declares no optional_env`, optionalEnv(one).join(","));
  }
  // Gmail and Calendar DO read an optional name — their hosted access token — and it is
  // deliberately not here: it comes from the OAuth spec's `accessSecretName` and is injected by
  // `connectorRunEnv`. Listing it in the catalog too would be a second place for that name to
  // live, which is the thing `optional_env` exists to stop rather than to create.
  check(optionalEnv(resolveSelected(all, ["gmail", "google_calendar"])).length === 0, "...including the two whose access token the OAuth service fills");
}

console.log("\nan agent with no connectors");
{
  const none = resolveSelected(all, []);
  check(userSuppliedEnv(none).length === 0, "asks the user for nothing");
  check(connectionSuppliedEnv(none).length === 0, "...and needs no connection");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
