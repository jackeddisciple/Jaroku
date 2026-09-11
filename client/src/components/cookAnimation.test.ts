// The cook animation has to play on every desktop Jaroku runs on: under the desktop CSP, which has
// no 'unsafe-eval'; offline; on an old webview as well as a new one; and in exactly the box the
// woman-cook emoji had. Each check below is one way it could stop doing that with no type error and
// no failing render to say so — it would just be an empty space, or an emoji again, on somebody
// else's machine.
//
//   npm run test:cook-animation

import { readFileSync } from "node:fs";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const read = (p: string): string => readFileSync(p, "utf8");

const src = read("src/components/CookAnimation.tsx");

console.log("\nthe file plays offline, with nothing for an eval-free player to miss");
{
  const raw = read("src/assets/cook.json");
  const data = JSON.parse(raw) as {
    w: number; h: number; fr: number; ip: number; op: number; assets?: Record<string, unknown>[];
  };
  // EXPRESSIONS ARE JAVASCRIPT inside the file, run by the full player with `eval`. The desktop CSP
  // refuses that and the light player leaves the engine out, so a file that used one would draw wrong.
  const expressions: string[] = [];
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === "object") {
      const x = (o as { x?: unknown }).x;
      if (typeof x === "string") expressions.push(x.slice(0, 40));
      Object.values(o).forEach(walk);
    }
  };
  walk(data);
  check("no expressions in it", expressions.length === 0, expressions.slice(0, 2).join("; "));
  check("no image assets — it is shapes only", !(data.assets ?? []).some((a) => "p" in a));
  check("and no URL anywhere in it, so it never reaches for the network", !/https?:\/\//.test(raw));
  check("a square canvas, so the emoji's square box holds it without letterboxing", data.w === data.h, `${data.w}×${data.h}`);
  check("a real loop: a frame rate and more than one frame", data.fr > 0 && data.op > data.ip, `${data.fr}fps ${data.ip}→${data.op}`);
}

console.log("\nthe player is the light one, and nothing in it needs eval");
{
  check("it loads `lottie_light`", src.includes('import("lottie-web/build/player/lottie_light")'));
  // A type import is erased; a value import of the package root would bring in the full player.
  check("and never the full player", !/^import (?!type )[^;]*from "lottie-web[^"]*";/m.test(src) && !src.includes('import("lottie-web")'));
  const player = read("node_modules/lottie-web/build/player/lottie_light.js");
  check("the light player calls no eval", !/(^|[^\w$.])eval\(/m.test(player));
  check("...and no Function constructor", !/new Function\(|(^|[^\w$.])Function\(/m.test(player));
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
  const pinned = pkg.dependencies["lottie-web"] ?? "";
  check("lottie-web is pinned to an exact version", /^\d+\.\d+\.\d+$/.test(pinned), pinned);
}

console.log("\nit loads lazily and fails soft");
{
  check("the animation is imported on mount too, not at the top",
    src.includes('import("../assets/cook.json")') && !/^import [^;]*cook\.json/m.test(src));
  check("a failed load falls back to the emoji it replaced", /\.catch\(/.test(src) && src.includes("{COOK_EMOJI}"));
  check("the emoji is built from code points, not typed",
    src.includes("String.fromCodePoint(0x1f469, 0x1f3fb, 0x200d, 0x1f373)"));
  const INVISIBLE = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0xa0].map((c) => String.fromCodePoint(c));
  check("no invisible character anywhere in the component", !INVISIBLE.some((c) => src.includes(c)));
  check("an old webview's media-query subscription is handled", src.includes("motion.addListener(apply)"));
  check("prefers-reduced-motion holds a still frame", src.includes("prefers-reduced-motion") && src.includes("goToAndStop("));
  check("the player is destroyed on unmount", src.includes("anim?.destroy()"));
}

console.log("\nit takes exactly the emoji's box");
{
  check("1.25em, like the emoji", src.includes('fontSize: "1.25em", width: "1em", height: "1em"'));
  check("4px of its 30 under the baseline", src.includes('verticalAlign: "-0.1333em"'));
  check("hidden from screen readers, because the words already say cook",
    (src.match(/aria-hidden/g) ?? []).length >= 2);
}

console.log("\nthe greeting uses it");
{
  const pane = read("src/components/BuildPane.tsx");
  check("BuildPane draws <CookAnimation /> in the greeting", pane.includes("<CookAnimation />"));
  check("and no longer spells the emoji itself", !pane.includes("1F469"));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
