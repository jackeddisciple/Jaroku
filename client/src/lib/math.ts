// Mathematics in a reply, typeset: KaTeX, loaded the first time a reply holds an equation.
//
// LAZY FOR THE HIGHLIGHTER'S REASON. Most replies have no maths, and KaTeX with its fonts is the heaviest
// thing a reply can ask for — so it loads once, when an equation first appears, and until it has (or if
// it never does) the TeX is shown as the source it is.
//
// TRUST IS OFF. `\href`, `\url` and the commands that make HTML are refused, so what comes back is
// KaTeX's own markup and never anything a model wrote; a formula with a mistake in it is drawn with the
// mistake marked rather than thrown.
//
//   npm run test:math

type Katex = { renderToString: (tex: string, opts: Record<string, unknown>) => string };

let katex: Promise<Katex> | null = null;
let styles: Promise<unknown> | null = null;

/** Typeset equations, by their TeX and whether they stand on their own lines. */
const typeset = new Map<string, string>();
const keyOf = (tex: string, display: boolean): string => `${display ? "D" : "I"}${tex}`;

function getKatex(): Promise<Katex> {
  if (!katex) {
    katex = import("katex").then((m) => ((m as { default?: unknown }).default ?? m) as Katex);
    katex.catch(() => {
      katex = null;
    });
  }
  return katex;
}

/** An equation this page has already typeset, so a redrawn reply shows it at once rather than flickering. */
export function typesetAlready(tex: string, display: boolean): string | undefined {
  return typeset.get(keyOf(tex, display));
}

/** An equation as KaTeX's HTML, or null — for nothing to typeset, or KaTeX that could not load. */
export async function typesetMath(tex: string, display: boolean): Promise<string | null> {
  if (!tex.trim()) return null;
  const known = typesetAlready(tex, display);
  if (known !== undefined) return known;
  try {
    const k = await getKatex();
    const html = k.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      trust: false,
      strict: "ignore",
      output: "htmlAndMathml",
      maxSize: 20,
      maxExpand: 1000,
    });
    typeset.set(keyOf(tex, display), html);
    return html;
  } catch {
    return null;
  }
}

/** KaTeX's stylesheet and the fonts it names, added to the page once, the first time an equation is drawn. */
export function loadMathStyles(): Promise<unknown> {
  if (!styles) {
    styles = import("katex/dist/katex.min.css").catch(() => {
      styles = null;
    });
  }
  return styles;
}
