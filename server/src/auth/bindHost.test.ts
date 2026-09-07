// Which interfaces the server answers on, asserted as a decision rather than left to Node.
//
// THE BUG THIS SUITE EXISTS FOR SHIPPED. `wsRelay.ts` called `this.http.listen(opts.port)` with no
// host, which binds every interface, and a desktop install mounts `POST /v1/auth/dev-login` — an
// email in, a real session token out, no password anywhere. Reachable from the LAN, that is account
// takeover for anybody on the same Wi-Fi, and `GET /v1/auth/methods` advertised it by answering
// `"localIssuer": true` to the same unauthenticated caller.
//
// SO THE ASSERTIONS ARE ABOUT THE DEFAULT, which is the part that was wrong. Anybody can set the
// variable; what matters is what happens when nobody has thought about it.
//
//   npm run test:bind-host

import { ALL_INTERFACES, BIND_HOST_ENV, LOOPBACK, isLoopback, resolveBindHost } from "./bindHost.ts";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Resolve against an environment of exactly these variables, collecting what was logged. */
function resolve(env: NodeJS.ProcessEnv): { host: string; log: string } {
  const lines: string[] = [];
  const host = resolveBindHost(env, (m) => lines.push(m));
  return { host, log: lines.join("\n") };
}

console.log("\nthe default is this machine only, because the alternative is a passwordless route on the LAN");
{
  // NO NODE_ENV AT ALL is a desktop install and a developer's `npm run dev`, which are the two
  // configurations with nothing in front of them and the two that must not answer the network.
  check("nothing configured binds loopback", resolve({}).host === LOOPBACK);
  check("...and says why", resolve({}).log.includes("no password"));
  check(
    "development is not special-cased into being open",
    resolve({ NODE_ENV: "development" }).host === LOOPBACK,
  );
  check("a test environment too", resolve({ NODE_ENV: "test" }).host === LOOPBACK);
}

console.log("\nproduction binds everything, because a container's port is published in front of it");
{
  // NOT A CONTRADICTION of the rule above: a process that bound loopback inside a container is one
  // the platform cannot route to. Production already refuses to start without the rest of the
  // hosted configuration, and the local issuer is refused there outright.
  const { host, log } = resolve({ NODE_ENV: "production" });
  check("production binds all interfaces", host === ALL_INTERFACES);
  check("...and says so", log.includes(ALL_INTERFACES));
}

console.log("\nan explicit value wins in both directions");
{
  check(
    "a hosted deploy can open a non-production server",
    resolve({ [BIND_HOST_ENV]: "0.0.0.0" }).host === "0.0.0.0",
  );
  check(
    "and production can be closed back down",
    resolve({ NODE_ENV: "production", [BIND_HOST_ENV]: "127.0.0.1" }).host === "127.0.0.1",
  );
  // Whitespace is what a value pasted out of a dashboard carries, and an untrimmed one would be
  // handed to `listen` as a hostname that resolves to nothing.
  check("padding is trimmed", resolve({ [BIND_HOST_ENV]: "  0.0.0.0  " }).host === "0.0.0.0");
  check("an empty value is not a value", resolve({ [BIND_HOST_ENV]: "   " }).host === LOOPBACK);
}

console.log("\nopening the server to the network is said out loud");
{
  // The one line somebody greps for when they are working out why this is or is not reachable.
  const opened = resolve({ [BIND_HOST_ENV]: "0.0.0.0" }).log;
  check("a non-loopback bind is called what it is", opened.includes("reachable from the network"));
  const closed = resolve({ [BIND_HOST_ENV]: "127.0.0.1" }).log;
  check("a loopback bind is not alarming about it", !closed.includes("reachable from the network"));
  check("...and still says what it did", closed.includes("this machine only"));
}

console.log("\nwhat counts as loopback, which two callers have to agree on");
{
  check("the address itself", isLoopback("127.0.0.1"));
  // The whole /8, not one address: 127.0.0.2 is equally this machine, and calling it external
  // would put a warning in front of somebody who had done the safe thing.
  check("the rest of 127/8", isLoopback("127.0.0.2") && isLoopback("127.255.255.254"));
  check("the name", isLoopback("localhost") && isLoopback("LOCALHOST"));
  check("IPv6", isLoopback("::1") && isLoopback("[::1]"));
  // What a dual-stack socket reports for an IPv4 client, and the same interface either way.
  check("the IPv4-mapped form", isLoopback("::ffff:127.0.0.1"));
  check("padding does not change the answer", isLoopback("  ::1  "));

  check("every interface is not loopback", !isLoopback(ALL_INTERFACES));
  check("a LAN address is not loopback", !isLoopback("192.168.1.6"));
  // The near-misses, because a substring test would pass all three and each is somebody else's
  // machine: a hostname that merely CONTAINS the word, and addresses outside the block.
  check("...nor is a name that contains it", !isLoopback("localhost.evil.example"));
  check("...nor 127 in the wrong octet", !isLoopback("10.0.127.1"));
  check("...nor the block next door", !isLoopback("128.0.0.1"));
  check("...nor an empty string", !isLoopback(""));
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
