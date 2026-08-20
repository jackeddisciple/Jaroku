// Where the session token goes, and — the assertion this suite exists for — where it does not.
//
// The load-bearing claim of `sessionVault.ts` is that under a host with a credential store the
// token NEVER touches `localStorage`. A mirror would be the easy implementation and would leave
// the protection notional while making it look real: the credential store would fill up
// correctly, and the token would still be sitting in a file any program running as this user can
// open. So this suite installs a `localStorage` that records every write and asserts it stays
// empty for the whole host section.
//
//   npm run test:session-vault

import { hydrate, read, write } from "./sessionVault.ts";

let failures = 0;
const check = (name: string, ok: boolean): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures++;
};

// A localStorage that behaves like the browser's, plus a note of everything ever written to it.
const store = new Map<string, string>();
const written: string[] = [];
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    written.push(k);
    store.set(k, v);
  },
  removeItem: (k: string) => {
    written.push(k);
    store.delete(k);
  },
};

const TOKEN = "jaroku.token";
const WORKSPACE = "jaroku.workspace";

console.log("\nin a browser, which is what npm run dev is");
{
  check("an absent key reads as null", read(TOKEN) === null);
  write(TOKEN, "abc");
  check("a token round-trips through localStorage", read(TOKEN) === "abc" && store.get(TOKEN) === "abc");
  write(TOKEN, null);
  check("...and clearing it removes the key rather than storing the string 'null'", read(TOKEN) === null);
  check("...actually removing it, not blanking it", !store.has(TOKEN));
}
{
  // `auth.ts` has always survived private browsing by treating a throwing store as an absent one.
  // The behaviour moved into this module and has to move with its guarantee.
  const real = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
    removeItem() {
      throw new Error("denied");
    },
  };
  check("storage that throws reads as absent rather than crashing", read(TOKEN) === null);
  let threw = false;
  try {
    write(TOKEN, "x");
  } catch {
    threw = true;
  }
  check("...and writing to it does not throw either", !threw);
  (globalThis as { localStorage?: unknown }).localStorage = real;
}

console.log("\nunder a host with a credential store");
{
  const keychain = new Map<string, string>();
  const asked: string[] = [];
  keychain.set(TOKEN, "from-the-keychain");

  (globalThis as { __TAURI__?: unknown }).__TAURI__ = {
    core: {
      invoke: async (command: string, args: { key: string; value?: string }) => {
        asked.push(`${command}:${args.key}`);
        if (command === "secret_get") return keychain.get(args.key) ?? null;
        if (command === "secret_set") return void keychain.set(args.key, args.value!);
        if (command === "secret_delete") return void keychain.delete(args.key);
        throw new Error(`unexpected command ${command}`);
      },
    },
  };

  written.length = 0;

  check("before hydrating, nothing is known — the cache is empty and nothing is guessed", read(TOKEN) === null);

  await hydrate([TOKEN, WORKSPACE]);
  check("hydrating asks the store for every key it was given", asked.includes(`secret_get:${WORKSPACE}`));
  check("...and a value that was there is now readable synchronously", read(TOKEN) === "from-the-keychain");
  check("...while a key with nothing behind it stays null", read(WORKSPACE) === null);

  write(WORKSPACE, "ws-1");
  check("a write is visible to the very next synchronous read", read(WORKSPACE) === "ws-1");

  write(TOKEN, null);
  check("clearing removes it from the cache immediately", read(TOKEN) === null);

  // The assertion this whole file is for. Every write above went to the credential store, and
  // `localStorage` — which is present, working and one line away — was never touched.
  check("NOTHING was written to localStorage while a credential store was available", written.length === 0);

  // And the round trips did happen, so the cache is not quietly the only storage there is.
  await Promise.resolve();
  check("the store was told to set the workspace", asked.includes(`secret_set:${WORKSPACE}`));
  check("...and told to delete the token", asked.includes(`secret_delete:${TOKEN}`));

  delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
