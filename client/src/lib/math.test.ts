// That an equation in a reply is really typeset, never trusted, and never an error on screen.
//
//   npm run test:math

import { typesetAlready, typesetMath } from "./math.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\nequations are typeset");
{
  const inline = await typesetMath("E = mc^2", false);
  check("an inline equation comes back as KaTeX markup", typeof inline === "string" && inline.includes('class="katex"'), String(inline).slice(0, 80));
  check("...with the TeX kept for screen readers and copying", typeof inline === "string" && inline.includes("<annotation") && inline.includes("E = mc^2"));
  check("...and not as a display equation", typeof inline === "string" && !inline.includes("katex-display"));
  const display = await typesetMath("\\int_0^1 x^2\\,dx = \\frac{1}{3}", true);
  check("a display equation is set on its own", typeof display === "string" && display.includes("katex-display"), String(display).slice(0, 80));
  check("a typeset equation is remembered", typesetAlready("E = mc^2", false) === inline);
  check("nothing to typeset is null", (await typesetMath("   ", false)) === null);
}

console.log("\nand never trusted, never thrown");
{
  const broken = await typesetMath("\\frac{1}{", false);
  check("a formula with a mistake is drawn with the mistake marked, not thrown", typeof broken === "string" && broken.includes("katex-error"), String(broken).slice(0, 120));
  const link = await typesetMath("\\href{javascript:alert(1)}{click}", false);
  check("\\href is refused, so no link comes back", typeof link === "string" && !/href="javascript/i.test(link), String(link).slice(0, 160));
  const markup = await typesetMath("\\text{<script>alert(1)</script>}", false);
  check("text inside an equation is escaped, never markup", typeof markup === "string" && !markup.includes("<script>"), String(markup).slice(0, 160));
}

console.log(fail === 0 ? "\nall math checks passed" : `\n${fail} math check(s) FAILED`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
