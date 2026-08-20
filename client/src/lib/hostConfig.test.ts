// What a host may tell this bundle, and — mostly — what it may not.
//
// The interesting assertions here are all refusals. A host that says nothing, a host that says
// something malformed and a host that is not there have to be the SAME outcome, because that
// outcome is "use the build-time default", which is a working application. Anything else is a
// socket URL nothing is listening on, and the symptom of that is a blank screen with a
// reconnecting strip — which reads as "the backend is down" and sends whoever is debugging it
// to the wrong half of the system entirely.

import { applyHostWsUrl, forgetHostUpdate, hostWsUrl } from "./hostConfig.ts";
// The two readers, imported so the seam between them is asserted rather than assumed. One of
// them never asked this module anything, which is the bug the last section here is about.
import { apiBase, socketUrl } from "./auth.ts";

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

console.log("\na host that corrects itself, because a supervised backend can move");
{
  forgetHostUpdate();
  check("a correction is accepted", applyHostWsUrl("ws://localhost:4321") === true);
  check("...and is what every reader gets from then on", hostWsUrl() === "ws://localhost:4321");
  check(
    "...even over an injected value, which was only ever the seed",
    withHost({ wsUrl: "ws://localhost:4317" }, hostWsUrl) === "ws://localhost:4321",
  );
  check("a malformed correction is refused", applyHostWsUrl("localhost:9999") === false);
  check("...and leaves the address that was working alone", hostWsUrl() === "ws://localhost:4321");
  check("an http correction is refused for the same reason an http injection is", applyHostWsUrl("http://x:1") === false);
  forgetHostUpdate();
  check("forgetting a correction goes back to the injected seed", withHost({ wsUrl: "ws://localhost:4317" }, hostWsUrl) === "ws://localhost:4317");
}

console.log("\nboth halves of the client follow the host, which is the bug this section is for");
{
  // THE REGRESSION TEST. `http.ts` computed its own origin from `VITE_JAROKU_WS` and never asked
  // this module, so on any launch where the shell had to move the port the socket and the sign-in
  // exchange went to the backend while the Secrets group, the checkout, the export and the
  // workspace deletion went to 4317 — nothing at all, or somebody else's server. Nothing in three
  // languages typechecks that seam; this is what checks it.
  forgetHostUpdate();
  const moved = withHost({ wsUrl: "ws://localhost:4319" }, () => ({
    socket: socketUrl("t"),
    api: apiBase(),
  }));
  check("the socket follows the host", moved.socket.startsWith("ws://localhost:4319/"));
  check("...and so does every HTTP surface", moved.api === "http://localhost:4319");

  // And per call rather than per module load, which is what makes a mid-session move work at all.
  applyHostWsUrl("ws://localhost:4320");
  check("a move after load moves the socket", socketUrl("t").startsWith("ws://localhost:4320/"));
  check("...and moves the HTTP surfaces with it", apiBase() === "http://localhost:4320");
  forgetHostUpdate();
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
