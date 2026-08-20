// What a host may tell this bundle, and — mostly — what it may not.
//
// The interesting assertions here are all refusals. A host that says nothing, a host that says
// something malformed and a host that is not there have to be the SAME outcome, because that
// outcome is "use the build-time default", which is a working application. Anything else is a
// socket URL nothing is listening on, and the symptom of that is a blank screen with a
// reconnecting strip — which reads as "the backend is down" and sends whoever is debugging it
// to the wrong half of the system entirely.

import { hostWsUrl } from "./hostConfig.ts";

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const global = globalThis as { __JAROKU_CONFIG__?: unknown };
function withHost<T>(value: unknown, run: () => T): T {
  const previous = global.__JAROKU_CONFIG__;
  global.__JAROKU_CONFIG__ = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete global.__JAROKU_CONFIG__;
    else global.__JAROKU_CONFIG__ = previous;
  }
}

console.log("\nno host at all");
delete global.__JAROKU_CONFIG__;
check(
  "a bundle running in a browser reads no host configuration",
  hostWsUrl() === undefined,
);
check(
  "...and reading it does not throw where `window` does not exist",
  (() => {
    try {
      hostWsUrl();
      return true;
    } catch {
      return false;
    }
  })(),
);

console.log("\na host that says where the backend is");
check(
  "the resolved port arrives as a ws:// origin",
  withHost({ wsUrl: "ws://localhost:4318" }, hostWsUrl) === "ws://localhost:4318",
);
check(
  "the ordinary launch is the same string the build-time default already had",
  withHost({ wsUrl: "ws://localhost:4317" }, hostWsUrl) === "ws://localhost:4317",
);
check(
  "a trailing slash is normalised away, so the ticket is not appended to a double slash",
  withHost({ wsUrl: "ws://localhost:4317/" }, hostWsUrl) === "ws://localhost:4317",
);
check(
  "wss is accepted, because a host is not required to be a loopback one",
  withHost({ wsUrl: "wss://relay.example/" }, hostWsUrl) === "wss://relay.example",
);

console.log("\na host that is wrong, which must read as a host that is absent");
check(
  "an http:// origin is refused rather than rewritten — the two variables are not the same one",
  withHost({ wsUrl: "http://localhost:4317" }, hostWsUrl) === undefined,
);
check("a value that is not a string is refused", withHost({ wsUrl: 4317 }, hostWsUrl) === undefined);
check("an empty string is refused", withHost({ wsUrl: "" }, hostWsUrl) === undefined);
check("a string that is not a URL is refused", withHost({ wsUrl: "localhost:4317" }, hostWsUrl) === undefined);
check("a config object with no wsUrl is refused", withHost({}, hostWsUrl) === undefined);
check("a config that is a string rather than an object is refused", withHost("ws://x", hostWsUrl) === undefined);
check("a config that is null is refused", withHost(null, hostWsUrl) === undefined);
check(
  "a field spelled the way a future host might get it wrong is refused, not guessed at",
  withHost({ ws_url: "ws://localhost:4318" }, hostWsUrl) === undefined,
);

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
