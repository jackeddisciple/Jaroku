// A finished run, stepped through on the graph: ⏮ ◀ ⏵ ▶ ⏭ along the canvas's bottom edge.
//
// THE TRACE TAB SAYS WHAT HAPPENED; THIS SHOWS WHERE. Each frame is a node finishing, lit on the
// graph with the edge the run arrived by, so a run can be walked the way it went — including the
// branch it took at a fork and the second pass round a loop. Marks only; the one piece of text is
// where you are, as a count.

import { useEffect } from "react";

import { Icon } from "../lib/icons/registry.ts";
import { ICON } from "../lib/tokens.ts";
import { ToolButton, ToolDivider } from "./GraphToolbar.tsx";

export function GraphRunStrip({
  count, at, playing, onAt, onPlaying, onClose,
}: {
  /** How many frames the run has. */
  count: number;
  /** The frame on screen, or null when the graph shows the run as it ended. */
  at: number | null;
  playing: boolean;
  onAt: (i: number | null) => void;
  onPlaying: (v: boolean) => void;
  onClose: () => void;
}) {
  // AUTOPLAY: a frame every 700ms, stopping at the last.
  useEffect(() => {
    if (!playing) return;
    const t = window.setInterval(() => {
      const next = (at ?? -1) + 1;
      if (next >= count) onPlaying(false);
      else onAt(next);
    }, 700);
    return () => window.clearInterval(t);
  }, [playing, at, count, onAt, onPlaying]);

  const i = at ?? count - 1;
  return (
    <div
      role="toolbar"
      aria-label="Step through the run"
      className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-card border border-edge bg-elevated/90 px-1 py-1 shadow-floating backdrop-blur"
    >
      <ToolButton label="First step" onClick={() => onAt(0)} disabled={i <= 0}>
        <Icon.graphControl.first size={ICON.sm} />
      </ToolButton>
      <ToolButton label="Previous step" onClick={() => onAt(Math.max(0, i - 1))} disabled={i <= 0}>
        <Icon.graphControl.prev size={ICON.sm} />
      </ToolButton>
      {playing ? (
        <ToolButton label="Pause the replay" onClick={() => onPlaying(false)}>
          <Icon.graphControl.pause size={ICON.sm} />
        </ToolButton>
      ) : (
        <ToolButton
          label="Replay the run"
          onClick={() => {
            if (at === null || at >= count - 1) onAt(0);
            onPlaying(true);
          }}
        >
          <Icon.graphControl.run size={ICON.sm} />
        </ToolButton>
      )}
      <ToolButton label="Next step" onClick={() => onAt(Math.min(count - 1, i + 1))} disabled={at !== null && i >= count - 1}>
        <Icon.graphControl.next size={ICON.sm} />
      </ToolButton>
      <ToolButton label="Last step" onClick={() => onAt(count - 1)} disabled={at !== null && i >= count - 1}>
        <Icon.graphControl.last size={ICON.sm} />
      </ToolButton>
      <span className="min-w-[3ch] px-1 text-center text-tiny tabular-nums text-muted" aria-live="polite">
        {at === null ? count : `${at + 1}/${count}`}
      </span>
      <ToolDivider />
      <ToolButton label="Close the replay" onClick={onClose}>
        <Icon.graphControl.close size={ICON.sm} />
      </ToolButton>
    </div>
  );
}
