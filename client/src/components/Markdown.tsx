// A reply, drawn: the blocks `lib/markdown.ts` reads, in the app's own type scale and palette.
//
// EACH SHAPE IS SAID ONCE, HERE. A heading is a rung of the type scale rather than a size somebody
// picked; a list's marker is the quiet ink; inline code is the same chip `Prose` puts on an identifier;
// a table and a code block sit on the panel surface with a hairline, like every other card-like thing
// in this client. Nothing in a reply introduces a colour, a radius or a size of its own.

import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";

import { highlightCode, isCommandBlock, languageLabel } from "../lib/highlight.ts";
import { Icon } from "../lib/icons/registry.ts";
import { parseMarkdown, type Block, type CalloutTone, type Inline } from "../lib/markdown.ts";
import { loadMathStyles, typesetAlready, typesetMath } from "../lib/math.ts";
import { openLink } from "../lib/openExternal.ts";
import { ICON } from "../lib/tokens.ts";
import { iconBtn } from "./buttons.ts";
import { CHIP_INK } from "./InlineCode.tsx";
import { AlertTriangleIcon, CheckIcon, InfoIcon, LightbulbIcon, type IconProps } from "./panelIcons.tsx";

/** Text with its line breaks kept: a single newline in a reply is a line the writer broke on purpose. */
function Lines({ text }: { text: string }) {
  const parts = text.split("\n");
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && <br />}
          {part}
        </span>
      ))}
    </>
  );
}

/**
 * A link in a reply: the words, underlined, opening the page in the user's own browser. An `<a href>` left
 * to itself would navigate the desktop app away to the page with no route back — see lib/openExternal.ts.
 * Anything that is not a web address is shown as its words with the address in the tooltip, and never
 * opened.
 */
function ReplyLink({ href, children }: { href: string; children: ReactNode }) {
  if (!/^https?:\/\//i.test(href)) {
    return (
      <span title={href} className="underline decoration-edge underline-offset-2">
        {children}
      </span>
    );
  }
  return (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        void openLink(href);
      }}
      className="text-ink underline decoration-edge underline-offset-2 transition-colors hover:decoration-ink focus-visible:outline-none focus-visible:shadow-focusring"
    >
      {children}
    </a>
  );
}

/**
 * An equation: typeset once it is whole, and until then — or if KaTeX cannot load — its TeX in the code
 * face, so a half-written formula reads as the source it is rather than as broken maths.
 */
function MathView({ tex, display, closed = true }: { tex: string; display: boolean; closed?: boolean }) {
  const [html, setHtml] = useState<string | null>(() => (closed ? typesetAlready(tex, display) ?? null : null));

  useEffect(() => {
    if (!closed) {
      setHtml(null);
      return;
    }
    let live = true;
    void Promise.all([typesetMath(tex, display), loadMathStyles()]).then(([h]) => {
      if (live) setHtml(h);
    });
    return () => {
      live = false;
    };
  }, [tex, display, closed]);

  if (display) {
    return html ? (
      // KaTeX's own markup, with trust off: its spans, never anything the reply wrote.
      <div className="overflow-x-auto overflow-y-hidden py-1 text-ink" dangerouslySetInnerHTML={{ __html: html }} />
    ) : (
      <pre className="overflow-x-auto rounded-card border border-hair bg-panel px-3 py-2.5 font-mono text-caption leading-[1.6] text-muted">
        <code>{tex}</code>
      </pre>
    );
  }
  return html ? <span className="text-ink" dangerouslySetInnerHTML={{ __html: html }} /> : <code className={CHIP_INK}>{tex}</code>;
}

function InlineView({ pieces }: { pieces: readonly Inline[] }) {
  return (
    <>
      {pieces.map((p, i) => {
        switch (p.kind) {
          case "text":
            return <Lines key={i} text={p.text} />;
          case "strong":
            // No weight class: the reset draws `strong` a step heavier than the text around it, and a
            // class here would be a second opinion about a weight the type scale already decided.
            return <strong key={i} className="text-ink"><InlineView pieces={p.children} /></strong>;
          case "em":
            return <em key={i}><InlineView pieces={p.children} /></em>;
          case "del":
            return <del key={i} className="text-muted"><InlineView pieces={p.children} /></del>;
          case "code":
            return <code key={i} className={CHIP_INK}>{p.text}</code>;
          case "math":
            return <MathView key={i} tex={p.tex} display={false} />;
          case "link":
            return (
              <ReplyLink key={i} href={p.href}>
                <InlineView pieces={p.children} />
              </ReplyLink>
            );
        }
      })}
    </>
  );
}

/**
 * A code or command block: what it is — its language, or "Terminal" for something to run — with a copy
 * button over it, and highlighted once it has closed. While it is still streaming it stays plain text:
 * re-highlighting on every delta is wasted work, and half a string colours the rest of a block wrong.
 */
function CodeBlock({ lang, text, closed }: { lang: string; text: string; closed: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setHtml(null);
    if (!closed) return;
    let live = true;
    void highlightCode(text, lang).then((h) => {
      if (live) setHtml(h);
    });
    return () => {
      live = false;
    };
  }, [text, lang, closed]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(t);
  }, [copied]);

  const command = isCommandBlock(lang);
  const what = command ? "command" : "code";
  return (
    <div className="overflow-hidden rounded-card border border-hair bg-panel">
      <div className="flex h-8 items-center justify-between border-b border-hair pl-3 pr-1">
        <span className="text-tiny text-muted">{languageLabel(lang)}</span>
        <button
          type="button"
          className={iconBtn}
          title={copied ? "Copied" : `Copy ${what}`}
          aria-label={copied ? "Copied" : `Copy ${what}`}
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => setCopied(false));
          }}
        >
          {copied ? <CheckIcon size={ICON.xs} /> : <Icon.turn.copy size={ICON.xs} />}
        </button>
      </div>
      {html ? (
        // shiki's own markup: every character of the code is escaped into spans, never interpreted.
        <div
          className="shiki-host overflow-x-auto px-3 py-2.5 font-mono text-caption leading-[1.6] [&_pre]:!bg-transparent"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-x-auto px-3 py-2.5 font-mono text-caption leading-[1.6] text-ink">
          <code>{text}</code>
        </pre>
      )}
    </div>
  );
}

/**
 * What each callout is called and marked with. Neutral, like every other surface in a reply, except a
 * caution — the one that says something could go wrong for real — whose mark takes the danger ink.
 */
const CALLOUT: Record<CalloutTone, { Mark: (p: IconProps) => ReactElement; word: string; ink: string }> = {
  note: { Mark: InfoIcon, word: "Note", ink: "text-muted" },
  tip: { Mark: LightbulbIcon, word: "Tip", ink: "text-muted" },
  important: { Mark: InfoIcon, word: "Important", ink: "text-ink" },
  warning: { Mark: AlertTriangleIcon, word: "Warning", ink: "text-ink" },
  caution: { Mark: AlertTriangleIcon, word: "Caution", ink: "text-err" },
};

// RUNGS, NOT WEIGHTS. Each heading is a step of the type scale and takes that step's own weight, so a
// reply's hierarchy is size, case and ink rather than a bold class laid over a size.
//
// A REPLY'S PROSE IS THE `label` RUNG, at 500 — heavier than `body`'s 400 — which is why the lower
// headings are NOT the rungs just under it. A 14px/400 heading over 13px/500 text reads as lighter than
// the paragraph it names, which is the opposite of a heading. So the top two take the 600 rungs, and
// the ones below them become the small caps this client already uses for a panel's own name: the same
// weight as the prose, set apart by case and letter-spacing instead.
const HEADING_CLASS: Record<number, string> = {
  1: "text-page text-ink",
  2: "text-section text-ink",
  3: "text-label uppercase tracking-wider text-ink",
  4: "text-tiny uppercase tracking-wider text-ink",
  5: "text-tiny uppercase tracking-wider text-muted",
  6: "text-tiny uppercase tracking-wider text-muted",
};

function BlockView({ block }: { block: Block }): ReactNode {
  switch (block.kind) {
    case "heading": {
      const Tag = (block.level <= 2 ? "h3" : block.level === 3 ? "h4" : "h5") as "h3" | "h4" | "h5";
      return (
        <Tag className={`${HEADING_CLASS[block.level]} ${block.level <= 3 ? "pt-2" : "pt-1"}`}>
          <InlineView pieces={block.inline} />
        </Tag>
      );
    }
    case "paragraph":
      return <p className="leading-[1.6]"><InlineView pieces={block.inline} /></p>;
    case "list": {
      const items = block.items.map((item, i) => (
        <li key={i} className="pl-1 leading-[1.6]">
          <Blocks blocks={item.blocks} tight />
        </li>
      ));
      return block.ordered ? (
        <ol start={block.start} className="list-decimal space-y-1 pl-5 marker:text-muted">{items}</ol>
      ) : (
        <ul className="list-disc space-y-1 pl-5 marker:text-faint">{items}</ul>
      );
    }
    case "quote":
      return (
        <blockquote className="relative pl-4 text-muted">
          <span aria-hidden className="absolute bottom-0.5 left-0 top-0.5 w-0.5 rounded-pill bg-edge" />
          <Blocks blocks={block.blocks} tight />
        </blockquote>
      );
    case "code":
      return <CodeBlock lang={block.lang} text={block.text} closed={block.closed} />;
    case "math":
      return <MathView tex={block.tex} display closed={block.closed} />;
    case "table":
      return (
        <div className="overflow-x-auto rounded-card border border-hair">
          <table className="w-full border-collapse text-caption">
            <thead className="bg-panel">
              <tr>
                {block.head.map((cell, c) => (
                  <th key={c} style={{ textAlign: block.align[c] ?? "left" }} className="border-b border-edge px-3 py-1.5 text-ink">
                    <InlineView pieces={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r} className="border-b border-hair last:border-b-0">
                  {row.map((cell, c) => (
                    <td key={c} style={{ textAlign: block.align[c] ?? "left" }} className="px-3 py-1.5 align-top text-ink">
                      <InlineView pieces={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "callout": {
      const { Mark, word, ink } = CALLOUT[block.tone];
      return (
        <div role="note" className="flex gap-2.5 rounded-card border border-hair bg-panel px-3 py-2.5">
          <span className={`mt-0.5 shrink-0 ${ink}`} aria-hidden>
            <Mark size={ICON.sm} />
          </span>
          <div className="min-w-0 flex-1">
            <div className={`text-tiny uppercase tracking-wider ${ink}`}>{block.title || word}</div>
            <div className="mt-1">
              <Blocks blocks={block.blocks} tight />
            </div>
          </div>
        </div>
      );
    }
    case "rule":
      return <hr className="border-hair" />;
  }
}

/** A run of blocks. `tight` inside a list item or a quote, where the blocks sit closer together. */
function Blocks({ blocks, tight = false }: { blocks: readonly Block[]; tight?: boolean }) {
  return (
    <div className={tight ? "space-y-1.5" : "space-y-3"}>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  );
}

/** A reply's Markdown, drawn. Re-read only when the text changes, which while streaming is each frame. */
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <Blocks blocks={blocks} />;
}
