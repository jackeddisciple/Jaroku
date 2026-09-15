// A reply, drawn: the blocks `lib/markdown.ts` reads, in the app's own type scale and palette.
//
// EACH SHAPE IS SAID ONCE, HERE. A heading is a rung of the type scale rather than a size somebody
// picked; a list's marker is the quiet ink; inline code is the same chip `Prose` puts on an identifier;
// a table and a code block sit on the panel surface with a hairline, like every other card-like thing
// in this client. Nothing in a reply introduces a colour, a radius or a size of its own.

import { useMemo, type ReactNode } from "react";

import { parseMarkdown, type Block, type Inline } from "../lib/markdown.ts";
import { CHIP_INK } from "./InlineCode.tsx";

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
          case "link":
            // The words, marked as a link, with the address in the tooltip.
            return (
              <span key={i} title={p.href} className="underline decoration-edge underline-offset-2">
                <InlineView pieces={p.children} />
              </span>
            );
        }
      })}
    </>
  );
}

// RUNGS, NOT WEIGHTS. Each heading is a step of the type scale and takes that step's own weight — the
// two 600 rungs for a section and its parts, then the body and label rungs below them — so a reply's
// hierarchy is size and ink, never a bold class laid over a size.
const HEADING_CLASS: Record<number, string> = {
  1: "text-title text-ink",
  2: "text-section text-ink",
  3: "text-body text-ink",
  4: "text-label text-ink",
  5: "text-label text-muted",
  6: "text-label text-muted",
};

function BlockView({ block }: { block: Block }): ReactNode {
  switch (block.kind) {
    case "heading": {
      const Tag = (block.level <= 2 ? "h3" : block.level === 3 ? "h4" : "h5") as "h3" | "h4" | "h5";
      return (
        <Tag className={`${HEADING_CLASS[block.level]} ${block.level <= 2 ? "pt-2" : "pt-1"}`}>
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
      return (
        <pre className="overflow-x-auto rounded-card border border-hair bg-panel px-3 py-2.5 font-mono text-caption leading-[1.6] text-ink">
          <code>{block.text}</code>
        </pre>
      );
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
