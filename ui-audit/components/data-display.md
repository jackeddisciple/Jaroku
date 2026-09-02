# Components — data display

| Component | Source | Purpose | Reuse notes |
|---|---|---|---|
| `Chip` | `Chip.tsx` | lifecycle chips, tags, filter chips | breaks a long identifier rather than overflowing its row |
| `StatusBadge` / `StatusDot` | `StatusBadge.tsx` | agent + deployment state | reused on fleet cards |
| `WorkGlyph` | `WorkGlyph.tsx` | six work statuses | Cockpit only |
| `ThreadGlyph` | `ThreadGlyph.tsx` | thread status | Threads only |
| `McpBadge` | `McpBadge.tsx` | marks an MCP-provenance tool | everywhere a tool appears |
| `AgentSparkline` | `AgentSparkline.tsx` | recent runs | agent card · agent detail · **fleet card** |
| `StatRow` | `StatRow.tsx` | a label/figure pair | agent detail, Usage |
| `Truncate` | `Truncate.tsx` | one-line text with a `title` | `variant="prose"` for sentences |
| `InlineCode` | `InlineCode.tsx` | an identifier inside prose | |
| `DiffStat` / `DiffBar` | `DiffStat.tsx`, `DiffBar.tsx` | `+n −m` | |

## Truncation

`Truncate` has a `prose` variant, and the distinction matters: a chip breaks a long identifier
rather than overflowing its row, but the composer's model label is **prose** in a row that may not
wrap — so a narrow pane once drew it one character per line and pushed the send button off the bar
(commit `fd0015d`).

## Mono is not for things that look technical

`typeScale.ts` `MONO_IS_FOR` exists as a checkable list rather than a comment because this is the
part people get wrong:

> **do not switch fonts merely because a string looks technical.** A slug, a version, a timestamp
> and a model name all LOOK like code and none of them is — they are metadata, they sit in sentences
> and in rows beside prose, and setting them in Mono is what made two thirds of this client's text
> monospaced. The test for Mono is not "does this look technical" but "would fixed-width columns
> materially help somebody parse it".

Mono is for source code, terminal output, logs, stack traces and diffs. Nothing else.

## Tabular figures

Cost and duration columns are `tabular-nums` with fixed widths (`8ch`, `7ch`) so figures align down
a column. This is applied in the Cockpit's work row and in Usage.
