// The syntax theme every highlighted surface uses — a reply's code block and the code pane alike —
// built from `CODE` (lib/tokens.ts), the product owner's palette darkened for a light page.
//
// A THEME OF OUR OWN RATHER THAN ONE OF SHIKI'S, because the palette is a decision about colours and
// a bundled theme is somebody else's: `vitesse-light` coloured the same code differently from how the
// palette names it. The scope map follows VS Code's Dark+, the theme the palette was taken from, so
// a keyword, a string or a type lands on the colour the palette gives it; TextMate picks the most
// specific matching scope, so `support.type.property-name` (a JSON key) is a property, not a type.
//
// A TRANSPARENT background: shiki writes one into its markup, and every surface code sits on already
// has its own.
//
//   npm run test:highlight

import { CODE } from "./tokens.ts";

/** The theme's name, as a highlighter is asked for it. Light, as `test:colour-system` requires. */
export const CODE_THEME_NAME = "jaroku-light";

type Rule = { scope: string[]; settings: { foreground?: string; fontStyle?: string } };

const rules: Rule[] = [
  { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: CODE.comment, fontStyle: "italic" } },
  {
    scope: ["string", "string.quoted", "string.template", "string.regexp", "punctuation.definition.string"],
    settings: { foreground: CODE.string },
  },
  { scope: ["constant.numeric"], settings: { foreground: CODE.number } },
  {
    scope: [
      "keyword", "keyword.control", "keyword.operator.new", "keyword.operator.expression", "keyword.operator.word",
      "keyword.operator.logical.python", "storage", "storage.type", "storage.modifier", "constant.language",
      "variable.language", "entity.name.tag",
    ],
    settings: { foreground: CODE.keyword },
  },
  { scope: ["keyword.operator", "punctuation", "meta.brace"], settings: { foreground: CODE.plain } },
  {
    scope: ["entity.name.function", "support.function", "variable.function", "meta.function-call.generic"],
    settings: { foreground: CODE.function },
  },
  {
    scope: [
      "variable", "variable.other", "variable.parameter", "variable.other.property", "variable.other.object.property",
      "meta.object-literal.key", "support.variable", "support.type.property-name", "entity.other.attribute-name",
    ],
    settings: { foreground: CODE.variable },
  },
  {
    scope: [
      "entity.name.type", "entity.name.class", "entity.name.namespace", "entity.other.inherited-class", "support.type",
      "support.class", "support.class.component", "storage.type.primitive", "support.type.primitive",
    ],
    settings: { foreground: CODE.type },
  },
];

/** The theme as shiki takes it: a TextMate theme, registered by name with `createHighlighter`. */
export const CODE_THEME = {
  name: CODE_THEME_NAME,
  type: "light" as const,
  fg: CODE.plain,
  bg: "transparent",
  colors: { "editor.foreground": CODE.plain, "editor.background": "transparent" },
  settings: [{ settings: { foreground: CODE.plain } }, ...rules],
  tokenColors: [{ settings: { foreground: CODE.plain } }, ...rules],
};
