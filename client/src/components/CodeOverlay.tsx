// Code overlay (doc §4.1): the full project isn't a permanent column — it opens on demand
// (a diff-card file row, or Cmd+P) and returns you to the conversation when dismissed. Reuses
// the existing CodeViewer; only the framing is new.

import { useEffect, useRef } from "react";
import { useBuildStore } from "../store/buildStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { CodeViewer } from "./CodeViewer.tsx";

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
    <div className="fixed inset-0 z-40 flex items-stretch justify-end bg-black/50" onClick={() => setOpen(false)}>
      <div
        className="w-[min(880px,80vw)] bg-bg flex flex-col shadow-2xl animate-slide-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-2 shrink-0 bg-panel">
          <span className="text-[11px] uppercase tracking-widest text-faint">Code</span>
          <button onClick={() => setOpen(false)} className="ml-auto text-muted hover:text-ink text-[13px]" title="Close (Esc)">
            ✕
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <CodeViewer />
        </div>
      </div>
    </div>
  );
}
