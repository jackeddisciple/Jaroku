// §8's pre-flight gate, in a file of its own so there is exactly one of it.
//
// IT WAS INSIDE `WorkComposer` AND PART 3 IS WHY IT MOVED. §6: "Part 2 already requires a pre-flight
// confirmation before any dispatch — the agent, the deployment version, the provider and model. An
// ambiguous message classified as a command still meets that gate, so the user always sees what is
// about to happen before money moves. That is the answer to classification uncertainty; do not add a
// second confirmation dialog beside it."
//
// A SECOND COPY OF THIS DIALOG WOULD BE THE SECOND CONFIRMATION that sentence forbids, even though
// it looked identical: two of them is two places for the version, the model or the public-URL
// warning to be wrong in, and the one that drifts is always the copy somebody made for the newer
// surface. So the Cockpit's composer and the operate thread's composer render the same component.

import { GATE } from "../lib/cockpitCopy.ts";
import type { FleetCardView } from "../types.ts";
import { CockpitDialog } from "./CockpitDialog.tsx";
import { Icon } from "../lib/icons/registry.ts";

/**
 * §8's pre-flight gate: what is about to happen, before the button that causes it.
 *
 * A SMALL MODAL WITH A SCRIM, which is §8's own instruction and the one place in this tab a modal
 * is right: "it is asking for a decision that spends money and touches the world". Everything else
 * about it is the app's existing dialog — `CockpitDialog` — rather than a bespoke one, and that is
 * also where §21's "the confirming control is not the default focus" is satisfied.
 *
 * IT NAMES WHAT WILL HAPPEN AND NOT WHAT IT WILL COST, deliberately. Nothing can honestly predict
 * the cost of a job whose graph has not run — the eval estimator works because it has a dataset and
 * a history, and this has one sentence somebody just typed. A confident figure here would be the
 * one number on this surface that was made up, on the tab whose whole argument is that its numbers
 * are real.
 *
 * IN §8's ORDER: the agent, the deployment version, the provider and model, the first line of the
 * input. A DEPLOYMENT WITH NO RECORDED VERSION SAYS SO rather than guessing one — a row written
 * before migration 041 has no record of which version it ran, and a confident "v1" would be a lie
 * about somebody's production on the one screen asking them to spend money.
 */
function GateBody({ card, input }: { card: FleetCardView; input: string }) {
  // THE FIRST LINE, which is what §8 asks for. A gate that rendered a 600-line pasted email would
  // be a dialog somebody scrolls rather than reads, and the point of the line is recognition —
  // "yes, that is the job I meant" — rather than review.
  const firstLine = input.split("\n", 1)[0] ?? "";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5 text-caption">
        <span className="text-ink">{card.agent_name}</span>
        <span className="text-muted">
          {card.version === null ? GATE.unrecordedVersion : `v${card.version}`}
          <span className="text-faint"> · </span>
          {card.model}
          <span className="text-faint"> on </span>
          {card.provider}
        </span>
        {/* THE ONE THING A PUBLIC ENDPOINT ADDS TO THE GATE. It is not about this job, it is about
            the agent this job is going to — and the moment somebody is being asked to spend money
            on it is the moment that fact is worth repeating. */}
        {card.connection === "public" && (
          <span className="text-warn">its URL is public, so anyone holding it can spend the same key</span>
        )}
      </div>
      <p className="truncate rounded-control border border-hair bg-canvas px-2 py-1 text-caption text-ink"
        title={firstLine}>
        {firstLine}
      </p>
    </div>
  );
}

/**
 * The dialog, ready to open. Both composers render this and neither owns it.
 *
 * `open` RATHER THAN A CONDITIONAL AT THE CALL SITE, so the dialog's own mount/unmount behaviour —
 * the scrim, the focus move, the Escape handler — is decided in one place. A caller that rendered it
 * conditionally would be deciding that too, differently.
 */
export function WorkGate({ card, input, open, onCancel, onConfirm }: {
  card: FleetCardView;
  input: string;
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <CockpitDialog
      open={open}
      title={GATE.title}
      body={<GateBody card={card} input={input} />}
      confirmLabel={GATE.confirm}
      confirmIcon={Icon.cockpitGate.dispatch}
      cancelIcon={Icon.cockpitGate.cancel}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
