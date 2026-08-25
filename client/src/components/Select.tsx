// The one dropdown that is not drawn by the operating system.
//
// SIX NATIVE `<select>` ELEMENTS WERE THE ONLY CONTROLS IN THIS PRODUCT THE OS DREW. Everything
// else — the model picker, the split button, eleven popovers — is markup this design system owns,
// and those six rendered a chunky platform chevron and opened a light-themed menu on a near-black
// surface. On Windows the Agents grid's `Last active` sort was the most visible example: a control
// that matched nothing else on screen, and a menu that matched nothing else in the product.
//
// The pattern is not new. `ModelSelector` in BuildPane and `SplitButton` already establish it —
// a trigger, a click-outside listener, Escape to close, an absolutely-positioned card at the menu
// layer. This is that, once, so a seventh dropdown cannot invent an eighth spelling of it.
//
// WHAT IS DELIBERATELY KEPT FROM THE NATIVE CONTROL: a real `<button>` with `aria-haspopup` and
// `aria-expanded`, arrow-key movement through the options, Enter and Space to choose, and Escape
// to cancel. A custom select that is only clickable is a worse control than the one it replaced,
// however much better it looks.

import { useEffect, useRef, useState } from "react";

import { ICON } from "../lib/tokens.ts";
import { ChevronDownIcon } from "./panelIcons.tsx";

export type SelectOption<T extends string> = {
  value: T;
  label: string;
  /** A second line under the label, for an option whose consequence needs a sentence. */
  detail?: string;
};

export function Select<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  title,
  ariaLabel,
  mono = false,
  className = "",
  align = "left",
  placeholder = "Select…",
}: {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  /** The label is an identifier — a branch name, a path. */
  mono?: boolean;
  className?: string;
  /** Which edge the menu hangs from. `right` for a trigger sitting at the end of a row. */
  align?: "left" | "right";
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const move = (step: number): void => {
    const at = options.findIndex((o) => o.value === value);
    const next = options[(at + step + options.length) % options.length];
    if (next) onChange(next.value);
  };

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { setOpen(false); return; }
          // Arrows move the choice with the menu closed, the way a native select does.
          if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
          if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
        }}
        className={`flex w-full min-w-0 items-center gap-1.5 rounded-control border border-hair bg-panel px-2 py-1 text-caption transition-colors duration-fast hover:border-edge focus-visible:outline-none focus-visible:shadow-focusring disabled:cursor-not-allowed disabled:opacity-40 ${
          open ? "border-edge text-ink" : "text-ink"
        } ${mono ? "font-mono" : ""}`}
      >
        <span className="min-w-0 flex-1 truncate text-left">{current?.label ?? placeholder}</span>
        <span
          className={`shrink-0 text-faint transition-transform duration-fast ${open ? "rotate-180" : ""}`}
          aria-hidden
        >
          <ChevronDownIcon size={ICON.xs} />
        </span>
      </button>

      {open && (
        <div
          role="listbox"
          className={`absolute top-full z-30 mt-1 max-h-[280px] min-w-full animate-slide-in overflow-auto rounded-card border border-edge bg-panel p-1 shadow-floating motion-reduce:animate-none ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              onClick={() => { onChange(o.value); setOpen(false); }}
              className={`flex w-full flex-col items-start gap-0.5 rounded-control px-2 py-1 text-left transition-colors duration-fast ${
                o.value === value ? "bg-active text-ink" : "text-muted hover:bg-active/40 hover:text-ink"
              }`}
            >
              <span className={`text-caption ${mono ? "font-mono" : ""}`}>{o.label}</span>
              {o.detail && <span className="text-tiny leading-[1.4] text-faint">{o.detail}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
