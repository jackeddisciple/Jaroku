// What the host is allowed to tell this page about its backend, and what it is not.
//
// THE ASSERTIONS THAT MATTER ARE THE REFUSALS AND THE ORDERING. A status that half-parses would
// put an error screen over a working application, which is a worse failure than the one this
// feature exists to fix; and a status that arrives before React mounts is the ONLY status on the
// launches this feature exists for, so the snapshot-versus-event ordering is the feature rather
// than a detail of it.
//
//   npm run test:host-backend

import { onBackendStatus, parseBackendStatus, type BackendStatus } from "./hostBackend.ts";
import { forgetHostUpdate, hostWsUrl } from "./hostConfig.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

console.log("\nreading a status");
{
  const ok = parseBackendStatus({
    phase: "failed",
    wsUrl: "ws://localhost:4318",
    message: "Port 4317 was taken",
    logPath: "C:\\Users\\x\\AppData\\Roaming\\jaroku\\logs\\desktop.log",
  });
  check(ok?.phase === "failed", "a failure arrives as one");
  check(ok?.wsUrl === "ws://localhost:4318", "...carrying where the backend actually is");
  check(ok?.message === "Port 4317 was taken", "...and the sentence somebody reads");
  check(ok?.logPath?.endsWith("desktop.log") === true, "...and where the rest of the story is");

  const bare = parseBackendStatus({ phase: "preparing", wsUrl: "ws://localhost:4317" });
  check(bare?.message === null, "an absent message is null rather than undefined, so a render has one branch");
  check(bare?.logPath === null, "...and so is an absent log path");
  check(
    parseBackendStatus({ phase: "started", wsUrl: "ws://x:1", message: "", logPath: "" })?.message === null,
    "an empty string is the same as absent — a blank line in a panel is not information",
  );
}

console.log("\na status this build does not understand, which must read as no status at all");
{
  check(parseBackendStatus(null) === null, "null is refused");
  check(parseBackendStatus("failed") === null, "a bare string is refused");
  check(parseBackendStatus({}) === null, "an object with no phase is refused");
  check(parseBackendStatus({ phase: "failed" }) === null, "a phase with no socket URL is refused");
  check(parseBackendStatus({ phase: "failed", wsUrl: "" }) === null, "...and an empty one is not a URL");
  // FORWARD COMPATIBILITY, WHICH IS A REAL CASE HERE: the shell and the page are versioned
  // together in this repository and are NOT versioned together on a user's disk, because the
  // page is embedded in the binary but a phase could be added in a build somebody is running
  // beside an older one. An unknown phase must read as silence, never as a failure.
  check(parseBackendStatus({ phase: "exploded", wsUrl: "ws://x:1" }) === null, "a phase from the future is refused");
  check(parseBackendStatus({ phase: 4, wsUrl: "ws://x:1" }) === null, "a phase that is not a string is refused");
}

console.log("\nno host, which is every browser");
{
  delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
  let called = 0;
  const stop = onBackendStatus(() => called++);
  check(typeof stop === "function", "subscribing returns an unsubscribe rather than undefined");
  stop();
  check(called === 0, "...and nothing is ever delivered");
}

console.log("\nthe ordering the launches this exists for depend on");
{
  // A HOST THAT HAD ALREADY FAILED BEFORE ANYBODY SUBSCRIBED. This is the shape of every launch
  // this feature is for: the shell settles `failed` during startup, which is before React has
  // mounted, so an event alone reaches nobody.
  const heard: BackendStatus[] = [];
  installHost({
    settled: { phase: "failed", wsUrl: "ws://localhost:4319", message: "no payload", logPath: null },
    emit: null,
  });
  const stop = onBackendStatus((s) => heard.push(s));
  await tick();
  check(heard.length === 1 && heard[0]?.phase === "failed", "a status settled before the subscription is still delivered");
  check(hostWsUrl() === "ws://localhost:4319", "...and its socket URL corrects the one the page was loaded with");
  stop();
  forgetHostUpdate();
}
{
  // AND THE OPPOSITE HOLE. Asking first, or letting a slow snapshot land after a live event,
  // would replace what is true now with what was true when the round trip started — which on a
  // recovering launch means an error screen appearing after the recovery.
  const heard: BackendStatus[] = [];
  installHost({
    settled: { phase: "failed", wsUrl: "ws://localhost:4319", message: "stale", logPath: null },
    emit: { phase: "started", wsUrl: "ws://localhost:4317", message: null, logPath: null },
  });
  const stop = onBackendStatus((s) => heard.push(s));
  await tick();
  check(heard.length === 1, `a live event makes the snapshot redundant rather than authoritative (${heard.length})`);
  check(heard[0]?.phase === "started", "...and what is delivered is the newer one");
  stop();
  forgetHostUpdate();
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);

// ---------------------------------------------------------------------------------------------

/** Enough of the Tauri global for this module: one command and one event. */
function installHost(opts: { settled: unknown; emit: unknown }): void {
  let deliver: ((message: { payload: unknown }) => void) | null = null;
  (globalThis as Record<string, unknown>).__TAURI__ = {
    event: {
      listen: (_name: string, handler: (message: { payload: unknown }) => void) => {
        deliver = handler;
        // The emit lands in the same turn the listener is attached, which is the race the
        // ordering guard is for: it happens before the snapshot's promise resolves.
        if (opts.emit) queueMicrotask(() => deliver?.({ payload: opts.emit }));
        return Promise.resolve(() => {
          deliver = null;
        });
      },
    },
    core: { invoke: () => Promise.resolve(opts.settled) },
  };
}

/** Let every queued microtask and promise settle. Two turns, because the subscription awaits
 *  twice: once for the listener and once for the snapshot. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
