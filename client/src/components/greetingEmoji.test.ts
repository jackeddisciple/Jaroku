// The greeting's emojis: the product owner's twenty-five, in their order, a new one every second
// after "What are we working on today, <name>?" in a crossfade smooth enough to be called buttery — and
// only the ones a machine can draw as colour emoji, so a Windows or Linux desktop never shows a box in
// the middle of the question.
//
//   npm run test:greeting-emoji

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ENTER, ENTER_MS, EXIT, EXIT_MS, GREETING_EMOJIS, GREETING_EMOJI_MS, GreetingEmoji,
} from "./GreetingEmoji.tsx";
import { canDrawEmoji } from "../lib/emojiSupport.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const read = (p: string): string => readFileSync(p, "utf8");
const hex = (s: string): string => [...s].map((c) => c.codePointAt(0)!.toString(16)).join(" ");

console.log("\nthe product owner's twenty-five, in their order");
{
  // Written as code points: which picture a sequence names is the whole point, and two of these
  // differ from a near-neighbour only by a variation selector or a skin tone nobody can see in source.
  const EXPECTED: number[][] = [
    [0x1f4ca], [0x1f5c2, 0xfe0f], [0x1f4ec], [0x1f4d6], [0x1f5d3, 0xfe0f], [0x260e, 0xfe0f],
    [0x1f469, 0x1f3fc, 0x200d, 0x1f4bb], [0x2708, 0xfe0f], [0x1f381], [0x1f45c], [0x1f3a7], [0x1f9c1],
    [0x1f4ee], [0x1f4d1], [0x1f4d2], [0x1f4dd], [0x1f45f], [0x1fab4], [0x1f3ab], [0x1f4f7], [0x1f4e0],
    [0x1f570, 0xfe0f], [0x1f4b3], [0x1f6cd, 0xfe0f], [0x1f388],
  ];
  check("twenty-five of them", GREETING_EMOJIS.length === 25, String(GREETING_EMOJIS.length));
  EXPECTED.forEach((cps, i) => {
    const want = cps.map((c) => c.toString(16)).join(" ");
    const got = GREETING_EMOJIS[i] ? hex(GREETING_EMOJIS[i]!) : "missing";
    check(`#${i + 1} is ${want}`, got === want, got);
  });
}

console.log("\none a second, in a crossfade rather than a swap");
{
  const src = read("src/components/GreetingEmoji.tsx");
  check("a new one every 1000ms", GREETING_EMOJI_MS === 1000 && src.includes("window.setInterval(() => setN((k) => k + 1), GREETING_EMOJI_MS)"));
  // ONLY THE TWO PROPERTIES A COMPOSITOR ANIMATES ON ITS OWN. Anything else — a width, a filter, a
  // top — is a layout or a repaint every frame, and that is what stutters on a busy machine.
  const props = [...ENTER, ...EXIT].flatMap((k) => Object.keys(k));
  check("the keyframes move only transform and opacity", props.every((p) => p === "transform" || p === "opacity"), props.join(","));
  check("the new one arrives from nothing to whole", ENTER[0]!.opacity === 0 && ENTER[ENTER.length - 1]!.opacity === 1);
  check("...while the old one leaves from whole to nothing", EXIT[0]!.opacity === 1 && EXIT[EXIT.length - 1]!.opacity === 0);
  check("the leaving is quicker than the arriving, so the two never crowd", EXIT_MS < ENTER_MS);
  check("and both are over well inside the second", ENTER_MS <= 600 && EXIT_MS <= 600);
  check("started before paint, so a new emoji is never seen at full size first",
    src.includes("useLayoutEffect") && src.includes("useBeforePaint(() => {"));
  check("the arrival holds its first frame until it starts", src.includes('fill: "backwards"'));
  check("the layers stay on the compositor for their whole life", src.includes('willChange: "transform, opacity"'));
  check("an invisible twin gives the box its size and baseline under the moving layers",
    src.includes('<span className="invisible">{current}</span>'));
  check("a webview without Web Animations shows one emoji, never two stacked", src.includes("canAnimate && n > 0 &&"));
  check("running animations are cancelled when the next change begins or the greeting goes",
    src.includes("running.forEach((a) => a?.cancel())"));
}

console.log("\nstill when asked, paused when unseen, and the same on an old webview");
{
  const src = read("src/components/GreetingEmoji.tsx");
  check("prefers-reduced-motion holds the first, nothing moving",
    src.includes("(prefers-reduced-motion: reduce)") && src.includes("if (motion.matches) setN(0)"));
  check("paused while the window is hidden", src.includes('"visibilitychange"') && src.includes('visibilityState !== "hidden"'));
  check("an old webview's media-query subscription is handled", src.includes("motion.addListener(sync)"));
  check("the interval is cleared on unmount", src.includes("window.clearInterval(timer)"));
  check("hidden from screen readers — decoration, not words", src.includes("aria-hidden"));
  check("a fixed 1em box at 1.25em, so the centred line never shifts", src.includes('style={{ fontSize: "1.25em", width: "1em" }}'));
  check("held to the last word by a no-break space", src.includes("String.fromCharCode(0xa0)") && src.includes("{NBSP}"));
  const INVISIBLE = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0xa0].map((c) => String.fromCodePoint(c));
  for (const p of ["src/components/GreetingEmoji.tsx", "src/lib/emojiSupport.ts"]) {
    check(`no invisible character typed in ${p}`, !INVISIBLE.some((c) => read(p).includes(c)));
  }
  // Rendered to markup, as other suites render the tree: nothing yet, and no `window` touched.
  check("renders nothing before it has asked what this machine can draw", renderToStaticMarkup(createElement(GreetingEmoji)) === "");
}

console.log("\nonly what this machine draws as colour emoji");
{
  // A canvas stand-in with a scenario: whether the glyph ignores the fill (colour) or takes it (a
  // box or an outline), whether anything is drawn at all, and how wide text measures.
  const fake = (s: { colour: boolean; inked: boolean; width?: (t: string) => number; noContext?: boolean; throws?: boolean }) =>
    ({
      createElement: () => {
        if (s.throws) throw new Error("no canvas here");
        let fill = "#000000";
        return {
          width: 0,
          height: 0,
          getContext: () =>
            s.noContext ? null : {
              font: "",
              textBaseline: "",
              set fillStyle(v: string) { fill = v; },
              get fillStyle() { return fill; },
              clearRect() {},
              fillText() {},
              getImageData: (_x: number, _y: number, w: number, h: number) => {
                const data = new Uint8ClampedArray(w * h * 4);
                if (s.inked) {
                  data[0] = s.colour ? 180 : fill === "#ff0000" ? 255 : 0;
                  data[2] = s.colour ? 40 : fill === "#0000ff" ? 255 : 0;
                  data[3] = 255;
                }
                return { data };
              },
              measureText: (t: string) => ({ width: s.width ? s.width(t) : 24 }),
            },
        };
      },
    }) as unknown as Document;
  const bar = GREETING_EMOJIS[0]!;
  const coder = GREETING_EMOJIS[6]!;
  check("a colour glyph is drawable", canDrawEmoji(bar, fake({ colour: true, inked: true })));
  check("a glyph painted in the fill colour — a box, an outline — is not", !canDrawEmoji(bar, fake({ colour: false, inked: true })));
  check("nothing drawn at all is not", !canDrawEmoji(bar, fake({ colour: true, inked: false })));
  check("a joined sequence drawn as one glyph is drawable",
    canDrawEmoji(coder, fake({ colour: true, inked: true, width: () => 24 })));
  check("...and drawn as its parts side by side is not",
    !canDrawEmoji(coder, fake({ colour: true, inked: true, width: (t) => (t === coder ? 48 : 24) })));
  check("no 2D context answers yes — the system font is worth trying", canDrawEmoji(bar, fake({ colour: false, inked: false, noContext: true })));
  check("a canvas that throws answers yes too", canDrawEmoji(bar, fake({ colour: false, inked: false, throws: true })));
}

console.log("\nthe greeting uses it");
{
  const pane = read("src/components/BuildPane.tsx");
  // The product owner's exact wording, 2026-09-11 — named and unnamed alike.
  check("the question is \"What are we working on today, <name>?\"",
    pane.includes("`What are we working on today, ${firstName}?`") && pane.includes('"What are we working on today?"'));
  check("BuildPane puts <GreetingEmoji /> after the question", /working on today\?"\}\s*<GreetingEmoji \/>\s*<\/h1>/.test(pane));
  check("and the cook animation is gone", !pane.includes("CookAnimation"));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
