// ⊕ Add — the explicit context channel, §4.
//
// WHY IT EXISTS, in the spec's own terms: Jaroku's context is passive and selection-based — the
// composer scopes to whatever trace step or graph node happens to be selected. That is right for
// the common case and useless for the rest. There is no way to reference a file you have not
// clicked, a run from yesterday, or a failing eval case without leaving the conversation. ⊕ is the
// explicit channel, and it is ADDITIVE to selection context rather than a replacement for it.
//
// THE BOUNDARY IS THE POINT (§4.5). ⊕ only brings context IN. It never pushes, pulls, commits,
// force-overrides, writes files or executes tools. Those are deliberate, confirmed, audit-logged
// actions and they live in their own panels. The composer gathers intent; it never performs
// privileged actions — and this is the control where blurring that line would be easiest and worst,
// because "attach a commit" and "push a commit" are one word apart.
//
// WHAT IS HERE NOW is the GitHub source, which is the one that already existed. The other four —
// File, Run, Dataset, Tool schema — arrive with M3 on the command-palette infrastructure, into this
// same popover. The menu deliberately renders nothing rather than five rows where four fail: §4.2's
// rule about the GitHub entry ("an empty menu item that always fails is worse than no item")
// generalises to every source, and a menu of dead options teaches people not to open it.

import { useEffect, useRef, useState } from "react";
import type { GithubAttachment, GithubView } from "../../types.ts";
import { GitHubAttachItems } from "../GitHubAttach.tsx";
import { EmptyState } from "../EmptyState.tsx";
import { Icon, GLYPH, Glyph } from "../icons.ts";
import { ControlButton } from "./ControlButton.tsx";
import { Popover } from "./Popover.tsx";

export function AddMenu({
  githubView,
  onAttachGithub,
  disabled = false,
  openSignal = 0,
}: {
  /** Null when the agent has no `github_links` row — §12.12, the option is hidden, not disabled. */
  githubView: GithubView | null;
  onAttachGithub: (attachment: GithubAttachment) => void;
  disabled?: boolean;
  /** §3.3's ⌘/. A counter rather than a boolean: the chord pressed twice must open the menu
   *  twice, and a flag that is already true is a keystroke that does nothing. */
  openSignal?: number;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Not on the first render — a nonce starting at 0 would open the menu on mount, which is a
  // popover over the composer every time somebody opens a thread.
  useEffect(() => {
    if (openSignal > 0 && !disabled) setOpen(true);
  }, [openSignal, disabled]);

  return (
    <div className="relative shrink-0">
      <ControlButton
        buttonRef={triggerRef}
        icon={Icon.Add}
        name="Attach context"
        title="Attach a file, run, dataset case, tool schema or GitHub reference"
        expanded={open}
        active={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      />
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={triggerRef} label="Attach context" width={280}>
        {githubView ? (
          <GitHubAttachItems view={githubView} onAttach={onAttachGithub} onDone={() => setOpen(false)} />
        ) : (
          // The zero state goes through EmptyState like every other one in the app (§1's
          // design-system table), rather than being a sentence somebody wrote in a div.
          <EmptyState
            size="inline"
            icon={({ size }) => <Glyph icon={Icon.Add} size={size ?? GLYPH.empty} />}
            title="Nothing to attach yet"
            hint="Link this agent to GitHub, or select a file or trace step — the composer already carries what you have selected."
          />
        )}
      </Popover>
    </div>
  );
}
