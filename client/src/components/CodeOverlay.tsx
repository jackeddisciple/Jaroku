// Code overlay (doc §4.1): the full project isn't a permanent column — it opens on demand
// (a diff-card file row, or Cmd+P) and returns you to the conversation when dismissed. Reuses
// the existing CodeViewer; only the framing is new.

import { useEffect, useRef } from "react";
import { useBuildStore } from "../store/buildStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { ICON } from "../lib/tokens.ts";
import { TYPE } from "../lib/tokens.ts";
import { CodeViewer } from "./CodeViewer.tsx";
import { XIcon } from "./panelIcons.tsx";

export function CodeOverlay() {
  const open = useUiStore((s) => s.codeOverlayOpen);
  const setOpen = useUiStore((s) => s.setCodeOverlay);
  const codeFocus = useBuildStore((s) => s.codeFocus);
  const firstFocus = useRef(codeFocus);

  // A diff-card file row (or the palette) bumps codeFocus to open the code.
  useEffect(() => {
    if (codeFocus !== firstFocus.current) {
      firstFocus.current = codeFocus;
      setOpen(true);
    }
  }, [codeFocus, setOpen]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    // ONE BACKDROP, ONE OPACITY — `void`, the colour the app itself sits on. There were three
// values across four overlays (black/50 here and in the palette, black/60 on the MCP modal,
// void/70 on the workspace panel), so the page darkened by a different amount depending on
// which control you had pressed.
<div className="fixed inset-0 z-40 flex items-stretch justify-end bg-void/80" onClick={() => setOpen(false)}>
      <div
        className="w-[min(880px,80vw)] bg-bg flex flex-col border-l border-edge shadow-overlay animate-slide-in motion-reduce:animate-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-hair px-4 py-2">
          <span className={TYPE.panelLabel}>Code</span>
          <button
            onClick={() => setOpen(false)}
            className="ml-auto text-muted transition-colors duration-fast hover:text-ink"
            title="Close (Esc)"
          >
            <XIcon size={ICON.sm} />
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <CodeViewer />
        </div>
      </div>
    </div>
  );
}
