// I5: every icon-only control has an accessible name and a tooltip, and they are the same string.
//
// THE FAILURE IS TOTAL AND SILENT. An icon-only button with no accessible name is announced as
// "button" — a screen-reader user is told something is there and nothing about what — and with no
// tooltip it is unguessable with a mouse. Neither shows up in a typecheck, in a screenshot, or in
// any amount of clicking around by somebody who already knows what the glyph means.
//
// TWO HALVES, BECAUSE THE RULE HAS TWO HALVES.
//
//   STRUCTURAL: `IconButton` is the one component every icon-only control goes through, and it
//   derives `title` from `label`, so the two CANNOT disagree. That is asserted by rendering it
//   rather than by reading it — the guarantee is about the markup that reaches a browser.
//
//   TEXTUAL: a call site that omits `label` is a type error, which is the point of making it
//   required — but a call site that passes an EMPTY string is not, and neither is one that
//   reintroduces a bare `<button>` around a registry mark. Both are swept for here.
//
//   npm run test:icon-a11y

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { check, done, read, sourceFiles } from "./harness.ts";
import { IconButton } from "../../components/IconButton.tsx";
import { Icon } from "./registry.ts";
import { HIT_TARGET } from "../../components/icons.ts";

console.log("\nthe label is the accessible name AND the tooltip, from one string");
{
  const html = renderToStaticMarkup(
    createElement(IconButton, { icon: Icon.agents.fork, label: "Fork agent" }),
  );
  check("aria-label carries it", html.includes('aria-label="Fork agent"'));
  check("title carries it too", html.includes('title="Fork agent"'));
  check("...and they are the same string",
    /aria-label="Fork agent"/.test(html) && /title="Fork agent"/.test(html));
  check("the mark itself is decorative", html.includes('aria-hidden="true"'));
  check("it is a real button", html.includes('type="button"'));
}

console.log("\na disabled control says WHY in the tooltip, and keeps its name");
{
  // §8: "Disabled state carries the reason in the tooltip, not a bare greyed mark." The accessible
  // name stays the action, because somebody needs to know what the control IS before they need to
  // know why it is off.
  const html = renderToStaticMarkup(
    createElement(IconButton, {
      icon: Icon.evals.run,
      label: "Run eval",
      disabledReason: "Add an example first",
    }),
  );
  check("the tooltip becomes the reason", html.includes('title="Add an example first"'));
  check("...and the accessible name stays the action", html.includes('aria-label="Run eval"'));
  check("...and it is actually disabled", html.includes("disabled"));
}

console.log("\na toggle reports its state");
{
  const on = renderToStaticMarkup(
    createElement(IconButton, { icon: Icon.agents.viewGrid, label: "Show the grid", active: true }),
  );
  const off = renderToStaticMarkup(
    createElement(IconButton, { icon: Icon.agents.viewGrid, label: "Show the grid" }),
  );
  check("aria-pressed when active", on.includes('aria-pressed="true"'));
  // `aria-pressed="false"` on a button that is not a toggle tells a screen reader it is one.
  check("...and no aria-pressed at all when it is not a toggle", !off.includes("aria-pressed"));
}

console.log("\nthe hit target does not follow the mark down");
{
  // §8: "Hit target at least 32x32 regardless of the rendered mark size." A 14px icon in a 14px
  // button is a control you miss on a trackpad and cannot hit on touch.
  const html = renderToStaticMarkup(
    createElement(IconButton, { icon: Icon.meta.duration, label: "Duration", size: 12 }),
  );
  check("32px minimum", HIT_TARGET >= 32);
  check("...and it reaches the markup", /min-width:32px/.test(html) && /min-height:32px/.test(html));
  check("...even when the mark inside is 12px", html.includes('width="12"'));
}

console.log("\nthe destructive treatment is the error tone, never amber");
{
  // I6: amber means RUNNING in this product. Drawing "kill the thing that is running" in the
  // colour of running is the one confusion this control must not create.
  const html = renderToStaticMarkup(
    createElement(IconButton, { icon: Icon.fleet.kill, label: "Kill this agent", danger: true }),
  );
  check("danger reaches for the error colour", /hover:text-err/.test(html));
  check("...and never for amber", !/text-warn|text-run|amber/.test(html));
}

console.log("\nno call site passes an empty label, and none rolls its own icon-only button");
{
  const files = sourceFiles().filter(
    (f) => !f.includes(".test.") && !f.endsWith("IconButton.tsx"),
  );
  let empty = 0;
  let rolled = 0;
  for (const file of files) {
    const text = read(file);
    for (const m of text.matchAll(/<IconButton[\s\S]{0,400}?\/>|<IconButton[\s\S]{0,400}?>/g)) {
      if (/label=(""|\{""\}|\{`\`\})/.test(m[0])) {
        empty++;
        console.log(`  FAIL ${file} passes an empty label`);
      }
    }
    // A bare <button> whose only content is a registry mark is an icon-only control that skipped
    // the component — the exact shape §8 exists to make impossible. It needs BOTH a `title` and an
    // `aria-label`: `title` alone is surfaced inconsistently as an accessible name, which is how a
    // control ends up looking named to the person who wrote it and reading as "button" out loud.
    //
    // A BUTTON WITH VISIBLE TEXT IS NOT ICON-ONLY and is excluded — "Open trace ↗" is named by the
    // words in it, and demanding an aria-label there would be asking for the label twice.
    for (const m of text.matchAll(/<button\b[\s\S]{0,600}?<\/button>/g)) {
      const block = m[0];
      const inner = block.slice(block.indexOf(">") + 1, block.lastIndexOf("</button>"));
      const hasMark = /<Icon\.[A-Za-z.]+[\s/]/.test(inner);
      // What a reader would see: markup and JSX expressions removed, comments removed.
      const visibleText = inner
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .replace(/\{[\s\S]*?\}/g, "")
        .replace(/<[^>]*>/g, "")
        .trim();
      const named = /aria-label=/.test(block) && /title=/.test(block);
      if (hasMark && visibleText === "" && !named) {
        rolled++;
        console.log(`  FAIL ${file} has an icon-only <button> that is not fully named`);
      }
    }
  }
  check("no empty label", empty === 0);
  check(`every hand-rolled icon-only button is named (${files.length} files swept)`, rolled === 0);
}

done();
