// The window's title, on both surfaces, with what is waiting in front.
//
// THE BUG. `setWindowTitle` built "(1) Jaroku — Cockpit Test" for `document.title` and sent the shell
// only the workspace's NAME; `set_window_title` rebuilt "Jaroku — <name>" from it, so on desktop —
// the one place a minimised window is read by its title — the count never showed.
//
//   npm run test:window-title

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const calls: { command: string; args: unknown }[] = [];
(globalThis as Record<string, unknown>)["__TAURI__"] = {
  core: { invoke: async (command: string, args?: unknown) => { calls.push({ command, args }); } },
};
const doc = { title: "" };
(globalThis as Record<string, unknown>)["document"] = doc;

const { setWindowTitle, titleFor } = await import("./windowTitle.ts");

console.log("\nthe same title on both surfaces");
{
  check(titleFor("Cockpit Test", 1) === "(1) Jaroku — Cockpit Test", "the page's title puts the count in front");
  setWindowTitle("Cockpit Test", 1);
  check(doc.title === "(1) Jaroku — Cockpit Test", "document.title carries it");
  const sent = calls.at(-1);
  check(sent?.command === "set_window_title", "the shell is asked as well");
  check(JSON.stringify(sent?.args) === JSON.stringify({ name: "Cockpit Test", waiting: 1 }),
    `...with the count, not only the name — ${JSON.stringify(sent?.args)}`);

  setWindowTitle("Cockpit Test", 0);
  check(JSON.stringify(calls.at(-1)?.args) === JSON.stringify({ name: "Cockpit Test", waiting: 0 }),
    "nothing waiting clears it there too");
  const before = calls.length;
  setWindowTitle("Cockpit Test", 0);
  check(calls.length === before, "an unchanged title does not cross again");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
