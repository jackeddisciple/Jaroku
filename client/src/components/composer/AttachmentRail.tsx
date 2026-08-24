// Band 1 — the attachment rail, §3.1 and §4.3.
//
// IT SITS ABOVE THE TEXTAREA AND NOT IN THE CONTROL BAR, and §3.1 gives the reason as a rule about
// what a thing IS: "Band 1 is CONTENT, not controls — it's what you're sending, so it sits with the
// text it belongs to, above it. Do not move chips into the bottom bar; they're variable-length and
// would push the controls around as they wrap."
//
// SO THE ONE INTERACTIVE ELEMENT PER CHIP IS ITS ×. Everything else about a chip is a readout.
//
// THE PATH TRUNCATES FROM THE MIDDLE (§4.3): `tools/…/weather.py` beats `tools/connect…`. The
// filename is the part somebody scans for, and a right-edge fade makes `tools/weather.py` and
// `tools/webhooks.py` the same string. That rule already lives in lib/truncatePath.ts with its own
// suite; this uses it rather than restating it.
//
// TWO ROWS, THEN `+N MORE`. Ten attachments at full width is three or four rows of chips, which
// pushes the textarea down far enough to move the send button — the one control whose position
// must not depend on how much context somebody attached.

import { useState } from "react";
import { Chip } from "../Chip.tsx";
import { Truncate } from "../Truncate.tsx";
import { Glyph, Icon, GLYPH } from "../icons.ts";
import { truncatePath } from "../../lib/truncatePath.ts";
import { XIcon } from "../panelIcons.tsx";
import { ICON, STATUS } from "../../lib/tokens.ts";
import type { AttachKind } from "./AttachPicker.tsx";

export interface DraftAttachment {
  /** Stable identity within the rail — the ref, key-order-independent. */
  key: string;
  kind: AttachKind;
  ref: Record<string, unknown>;
  label: string;
  tokenEstimate: number;
  protected: boolean;
  /** §9: a resolution failure puts the chip in an error tone with a retry, and blocks send. */
  error?: string | null;
}

const ICON_FOR: Record<AttachKind, (typeof Icon)[keyof typeof Icon]> = {
  file: Icon.AttachFile,
  run: Icon.AttachRun,
  dataset_case: Icon.AttachDataset,
  tool_schema: Icon.AttachTool,
  github: Icon.Github,
};

/** How many chips render before the rest collapse. Two rows' worth at a typical composer width. */
const VISIBLE = 6;

export function AttachmentRail({
  attachments,
  onRemove,
}: {
  attachments: DraftAttachment[];
  onRemove: (key: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (attachments.length === 0) return null;

  const shown = expanded ? attachments : attachments.slice(0, VISIBLE);
  const hidden = attachments.length - shown.length;

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1">
      {shown.map((a) => (
        <Chip
          key={a.key}
          size="md"
          mono={a.kind === "file"}
          // §9: an attachment that could not be resolved goes to an error tone and send is blocked
          // until it is fixed or removed. A chip that looked fine over a ref the server could not
          // read would be a turn sent with a hole in its context.
          color={a.error ? STATUS.error : undefined}
          title={
            a.error
              ? `${a.label} — ${a.error}`
              : a.protected
                ? `${a.label} — read-only. Attaching it never implies write access.`
                : `${a.label} · about ${a.tokenEstimate.toLocaleString()} tokens`
          }
          icon={
            <span className="text-faint">
              <Glyph icon={ICON_FOR[a.kind]} size={GLYPH.meta} />
            </span>
          }
        >
          {/* Middle-truncated for paths, plain for everything else — a run id or a PR number has
              no middle worth losing. */}
          <Truncate>{a.kind === "file" ? truncatePath(a.label, 32) : a.label}</Truncate>
          {a.protected && (
            <span className="shrink-0 text-[9px] text-faint" aria-label="read-only" title="Read-only">
              🔒
            </span>
          )}
          <button
            type="button"
            onClick={() => onRemove(a.key)}
            aria-label={`Remove ${a.label}`}
            title="Remove"
            className="shrink-0 text-faint transition-colors duration-fast hover:text-ink"
          >
            <XIcon size={ICON.xs} />
          </button>
        </Chip>
      ))}

      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="rounded-chip px-2 py-1 text-[11px] text-muted transition-colors duration-fast hover:text-ink"
        >
          +{hidden} more
        </button>
      )}
      {expanded && attachments.length > VISIBLE && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="rounded-chip px-2 py-1 text-[11px] text-faint transition-colors duration-fast hover:text-ink"
        >
          show fewer
        </button>
      )}
    </div>
  );
}
