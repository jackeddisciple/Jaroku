// The greeting's emojis: the product owner's twenty-five, in their order, a new one every second
// after "What should we cook today, Sumu?" on a buttery slide — and only the ones a machine can draw
// as colour emoji, so a Windows or Linux desktop never shows a box in the middle of the question.
//
//   npm run test:greeting-emoji

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  FADE_IN, FADE_IN_MS, FADE_OUT, FADE_OUT_MS, GREETING_EMOJIS, GREETING_EMOJI_MS, GreetingEmoji,
  SLIDE_EASE, SLIDE_IN, SLIDE_MS, SLIDE_OUT,
} from "./GreetingEmoji.tsx";
import { canDrawEmoji } from "../lib/emojiSupport.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const read = (p: string): string => readFileSync(p, "utf8");
const hex = (s: string): string => [...s].map((c) => c.codePointAt(0)!.toString(16)).join(" ");
const last = <T,>(a: readonly T[]): T => a[a.length - 1]!;

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

console.log("\none a second, on a slide that moves as one reel");
{
  const src = read("src/components/GreetingEmoji.tsx");
  check("a new one every 1000ms", GREETING_EMOJI_MS === 1000 && src.includes("window.setInterval(() => setN((k) => k + 1), GREETING_EMOJI_MS)"));
  // ONLY THE TWO PROPERTIES A COMPOSITOR ANIMATES ON ITS OWN. Anything else — a top, a margin, a
  // filter — is a layout or a repaint every frame, and that is what stutters on a busy machine.
  check("the slides move only transform", [...SLIDE_IN, ...SLIDE_OUT].every((k) => Object.keys(k).join() === "transform"));
  check("the fades move only opacity", [...FADE_IN, ...FADE_OUT].every((k) => Object.keys(k).join() === "opacity"));
  check("the new one comes up from one box below", SLIDE_IN[0]!.transform === "translateY(100%)" && last(SLIDE_IN).transform === "translateY(0)");
  check("the old one rises out to one box above", SLIDE_OUT[0]!.transform === "translateY(0)" && last(SLIDE_OUT).transform === "translateY(-100%)");
  // ONE REEL: the same distance, the same curve, the same time — so at every instant the two are
  // exactly one box apart, which is what makes it a slide rather than two things moving.
  check("both slides run on the one curve for the one duration",
    src.includes("animate(SLIDE_IN, { duration: SLIDE_MS, easing: SLIDE_EASE")
      && src.includes("animate(SLIDE_OUT, { duration: SLIDE_MS, easing: SLIDE_EASE"));
  const [, y1, , y2] = (SLIDE_EASE.match(/[\d.]+/g) ?? []).map(Number);
  check("the curve decelerates without overshooting — buttery, not bouncy", y1! <= 1 && y2! <= 1, SLIDE_EASE);
  check("the new one arrives from nothing, the old one leaves to nothing",
    FADE_IN[0]!.opacity === 0 && last(FADE_IN).opacity === 1 && FADE_OUT[0]!.opacity === 1 && last(FADE_OUT).opacity === 0);
  check("the fades are quicker than the slide, so neither is seen far from the box", FADE_IN_MS < SLIDE_MS && FADE_OUT_MS < SLIDE_MS);
  check("and it is all over well inside the second", SLIDE_MS <= 700);
  check("started before paint, so a new emoji is never seen sitting in place first",
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
  check("hidden from screen readers — the words already say cook", src.includes("aria-hidden"));
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
  check("BuildPane puts <GreetingEmoji /> after the question", /cook today\?"\}\s*<GreetingEmoji \/>\s*<\/h1>/.test(pane));
  check("and the cook animation is gone", !pane.includes("CookAnimation"));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
