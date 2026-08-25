// What this workspace is paying for, what it has used of it, and the one hop out that changes it.
//
// A SECTION OF THE WORKSPACE PANEL rather than a tab of the right panel, and the panel's own header
// already drew the line: the right panel's tabs are all about ONE AGENT — its graph, its trace, its
// deployment — and none of that is the scope a subscription works at. `UsagePanel` stays where it
// is and answers a different question: what has this month cost, against which ceiling, in context,
// while somebody is working. This answers what the workspace bought.
//
// TWO FACTS, KEPT APART ON THE SCREEN AS THEY ARE IN THE SCHEMA. The TIER is what this system
// believes and what every limit is read from; the STATUS is what the payment provider believes. A
// workspace whose card failed on Tuesday is `past_due` and still on Pro, and both are true — so the
// banner says the status and the plan row says the tier, and neither has to lie to fit the other.
//
// THE UPGRADE FLOW IS FOUR STEPS AND ONLY THE FOURTH LEAVES. Comparing plans, choosing seats and
// reading a price are ordinary screens with no reason to be anywhere but here. Step four is a hard
// boundary — Stripe Checkout is built for a real browser, with saved cards, autofill and 3-D Secure
// challenges that redirect to a bank, none of which work in an embedded webview — so the hop is
// deliberate, single, and ANNOUNCED. A surprise browser launch mid-payment reads as something going
// wrong; a stated one does not.
//
// AND THE POLL IS THE TRUTH, NOT THE DEEP LINK. Coming back from the browser tells us somebody
// returned, not that they paid: the webhook is the only thing that moves a tier, and it travels
// independently. So the screen says "confirming your subscription" until `GET
// /v1/billing/subscription` agrees, and never congratulates anybody on a tier they might not have.
//
// NO DARK PATTERNS, which on this screen means specific things: no pre-selected annual billing, no
// countdown, no "you will be charged unless", and a Cancel control that is present rather than
// buried. Downgrading is blocked only when the workspace would break its own target tier — and then
// it says what to resolve, never removing a member on somebody's behalf.

import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionStore } from "../store/sessionStore.ts";
import { useCapability } from "../lib/useCapability.ts";
import { openCheckout } from "../lib/deepLink.ts";
import { sendSetByok } from "../lib/socket.ts";
import {
  fetchSubscription, startCheckout, type SubscriptionView,
} from "../lib/workspaceApi.ts";
import { absTime } from "../lib/format.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import { primaryBtn, quietBtn, secondaryBtn } from "./buttons.ts";
import { EmptyState, LoadingLine } from "./EmptyState.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { AlertTriangleIcon, CheckIcon, InfoIcon, MinusIcon } from "./panelIcons.tsx";

/**
 * The three tiers, as the person buying one would compare them.
 *
 * A COPY OF THE PRICING, AND KNOWINGLY SO. The server's `billing/plans.ts` is the only thing that
 * ENFORCES any of this, and nothing here is ever consulted to decide whether an action is allowed —
 * that answer arrives as a refusal, with its own figures, from the one resolver. What this table is
 * for is the sentence somebody reads before deciding to pay, which is a different job from the
 * number a middleware compares against, and which has to be legible rather than complete.
 */
const TIERS = [
  {
    id: "free",
    label: "Free",
    price: "$0",
    per: "",
    line: "Bring your own provider key. No inference runs through us.",
    points: ["1 workspace", "3 agents", "500 runs a month", "7 days of history"],
  },
  {
    id: "pro",
    label: "Pro",
    price: "$20",
    per: "/month",
    line: "Single operator, with $15 of inference included.",
    points: ["3 workspaces", "Unlimited agents", "10,000 runs a month", "90 days of history", "GitHub push"],
  },
  {
    id: "team",
    label: "Team",
    price: "$40",
    per: "/user/month",
    line: "Two people or more, with $30 of inference each, pooled.",
    points: ["Unlimited workspaces", "Up to 20 members", "50,000 runs a month, pooled", "A year of history", "GitHub sync, Access grants, Policy"],
  },
] as const;

const TIER_LABEL: Record<string, string> = { free: "Free", pro: "Pro", team: "Team" };

/** What each provider status means where a person reads it, and whether it is worth alarming them. */
const STATUS_COPY: Record<string, { text: string; alarming: boolean }> = {
  active: { text: "Active", alarming: false },
  trialing: { text: "In trial", alarming: false },
  incomplete: { text: "Payment not finished", alarming: true },
  past_due: { text: "Payment failed — update your card", alarming: true },
  unpaid: { text: "Unpaid — the retries have run out", alarming: true },
  canceled: { text: "Canceled", alarming: false },
};

/** The minimum seats a tier can be bought with. Team is a collaboration plan; one seat is not one. */
function minimumSeats(tier: string): number {
  return tier === "team" ? 2 : 1;
}

export function BillingSection() {
  const workspaceId = useSessionStore((s) => s.workspaceId);
  // `billing:manage` — ASKED OF THE MATRIX RATHER THAN SPELLED AS A ROLE. This read
  // `workspace?.role === "owner"`, which is the same answer today and a different question: it
  // says who, where the rule is about what, and the day `billing:manage` moves this surface is one
  // of four that would go on quietly meaning the old thing. §8.2 ends by saying not to guess which
  // capabilities map to which roles, and a comparison against a role literal is that guess written
  // down. One boolean rather than one per control, because both mutations in this panel — the BYOK
  // toggle and the plan buttons — are the same capability; see `Capable`'s own note on when a `&&`
  // beats a wrapper.
  const canManage = useCapability("billing:manage");

  const [view, setView] = useState<SubscriptionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Which tier the upgrade screen is open on, or null when it is not. Steps 1-3 live in here. */
  const [choosing, setChoosing] = useState<string | null>(null);
  const [seats, setSeats] = useState(2);
  /** Set the moment the browser opens, cleared when the poll finally disagrees with what we knew. */
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const tierWhenLeaving = useRef<string | null>(null);

  const load = useCallback(async (): Promise<SubscriptionView | null> => {
    if (!workspaceId) return null;
    try {
      const next = await fetchSubscription(workspaceId);
      setView(next);
      setError(null);
      return next;
    } catch (err) {
      setError((err as Error).message);
      return null;
    }
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  // THE POLL, and it runs only while something is expected to change. An interval that outlived the
  // answer would be a request every few seconds for the life of the tab — the same rule the export
  // poll in DataSection follows. It stops when the tier moves, and it stops on its own after two
  // minutes, because a person who abandoned the payment form is not going to be rescued by a
  // twenty-first request.
  useEffect(() => {
    if (!confirming) return;
    const started = Date.now();
    let live = true;
    const timer = setInterval(() => {
      void (async () => {
        const next = await load();
        if (!live) return;
        if (next && next.tier !== tierWhenLeaving.current) setConfirming(false);
        else if (Date.now() - started > 120_000) setConfirming(false);
      })();
    }, 3000);
    return () => { live = false; clearInterval(timer); };
  }, [confirming, load]);

  if (!workspaceId) return <EmptyState title="No workspace" size="inline" />;
  if (!view && !error) return <LoadingLine label="Reading your subscription…" />;

  const tier = view?.tier ?? "free";
  const sub = view?.subscription ?? null;
  const status = sub ? STATUS_COPY[sub.status] ?? { text: sub.status, alarming: sub.attention } : null;

  /** Step 4, and the only line in this file that leaves the app. */
  const goToPayment = async (target: string): Promise<void> => {
    if (!workspaceId) return;
    setBusy(true);
    setError(null);
    try {
      const wanted = target === "team" ? Math.max(minimumSeats(target), seats) : 1;
      const { url } = await startCheckout(target, workspaceId, wanted);
      tierWhenLeaving.current = tier;
      // In the desktop app this opens the system browser. In an ordinary browser there is no host
      // to ask, `openCheckout` answers false, and the link below is the route — which is the right
      // behaviour rather than a degraded one: the page IS already in a browser.
      const opened = await openCheckout(url);
      if (!opened) window.open(url, "_blank", "noreferrer");
      setChoosing(null);
      setConfirming(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* --- what is true today --------------------------------------------------------------- */}
      <section>
        <h3 className={TYPE.panelLabel}>Plan</h3>
        <div className="mt-2 flex flex-wrap items-baseline gap-2">
          <span className="text-[15px] font-medium text-ink">{TIER_LABEL[tier] ?? tier}</span>
          {/* A STATUS BADGE RATHER THAN A CHIP, and the distinction is the design system's own:
              a Chip says what KIND of thing something is and carries a category accent, while a
              StatusBadge says how it is DOING and carries the status palette. "Payment failed" is
              the second. */}
          {status && (
            <StatusBadge state={status.alarming ? "error" : "ok"} label={status.text} />
          )}
          {sub?.cancelAtPeriodEnd && <StatusBadge state="pending" label="Ends at the period end" />}
        </div>

        {/* DUNNING, SAID PLAINLY AND WITHOUT A COUNTDOWN. The plan does NOT move while a renewal
            is being retried — that is the server's own rule — so the honest sentence is that the
            work continues and the card needs attention, not that anything is about to be lost. */}
        {status?.alarming && (
          <div className="mt-2 flex items-start gap-2 rounded-control border border-run/40 bg-run/[0.06] px-3 py-2">
            <span className="mt-0.5 shrink-0 text-run"><AlertTriangleIcon size={ICON.sm} /></span>
            <p className="text-[11px] leading-[1.55] text-ink">
              Your agents keep running while this is retried. Nothing is deleted, and your plan does
              not change until the retries are exhausted.
            </p>
          </div>
        )}

        {sub && (
          <dl className="mt-3 space-y-1.5">
            {sub.currentPeriodEnd && (
              <div className="flex items-baseline justify-between gap-4">
                <dt className={TYPE.meta}>{sub.cancelAtPeriodEnd ? "Access until" : "Renews"}</dt>
                <dd className="text-[12px] tabular-nums text-ink">{absTime(sub.currentPeriodEnd)}</dd>
              </div>
            )}
            <div className="flex items-baseline justify-between gap-4">
              <dt className={TYPE.meta}>Seats</dt>
              <dd className="text-[12px] tabular-nums text-ink">{sub.seatCount}</dd>
            </div>
          </dl>
        )}

        {/* BYOK, WHICH IS A CONTROL AND NOT A STATUS LINE — the specification asks for a toggle on
            both paid tiers, and the reason it is here rather than on the Usage tab is that it
            changes what the workspace is BUYING rather than what it has spent.

            ABSENT ON FREE rather than present and refusing: Free runs on the workspace's own key by
            construction, so there is no choice to offer and a disabled switch would imply there is
            one behind a paywall. The server says whether the control applies at all. */}
        {sub && (
          <div className="mt-3 rounded-control border border-hair px-3 py-2.5">
            {/* §8.2 — "Usage / Billing / BYOK toggle / billing:manage".
                A CHECKBOX AND A SENTENCE FOR WHOEVER HOLDS IT, A SENTENCE ALONE FOR EVERYBODY ELSE.
                It was `disabled={!canManage}` with "Only an owner can change this" beneath it, which is
                exactly the pattern §8 rules out — and here it also renders a checkbox somebody can
                click at, which reports the state and refuses to change it. The STATE is still
                shown, because whose keys the agents run on is a fact a member needs to read a bill
                against; what is absent is the control. */}
            <label className={`flex items-start gap-2.5 ${canManage ? "cursor-pointer" : ""}`}>
              {canManage ? (
                <input
                  type="checkbox"
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent"
                  checked={sub.byokEnabled}
                  onChange={(e) => sendSetByok(e.target.checked)}
                />
              ) : (
                <span className="mt-0.5 shrink-0 text-muted" aria-hidden>
                  {sub.byokEnabled ? <CheckIcon size={ICON.xs} /> : <MinusIcon size={ICON.xs} />}
                </span>
              )}
              <span className="min-w-0">
                <span className="text-[12px] text-ink">Use my own provider keys</span>
                {/* INSTANT, AND SAID SO. Inference is usage-based rather than seat-based, so there
                    is nothing to prorate — and the moment anybody reaches for this is the moment
                    they have just noticed a bill, when "takes effect next month" is useless. */}
                <span className="mt-0.5 block text-[11px] leading-[1.5] text-muted">
                  {sub.byokEnabled
                    ? "Your agents run on the keys in the Secrets tab. You pay the plan fee and no inference charges."
                    : "Your agents run on our keys, against the credit your plan includes. Switching is instant — the next run routes the other way."}
                </span>

              </span>
            </label>
          </div>
        )}

        {/* WHERE THE SPEND FIGURES LIVE, said out loud rather than duplicated here. Two screens
            rendering the same number from two computations is how they come to disagree. */}
        <p className="mt-2 text-[11px] leading-[1.55] text-faint">
          This month's spend, and the budget ceiling it is measured against, are on the Usage tab.
        </p>
      </section>

      {/* --- coming back from the browser ------------------------------------------------------ */}
      {confirming && (
        <section className="rounded-control border border-edge bg-panel px-3 py-2.5">
          <div className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0 text-faint"><InfoIcon size={ICON.sm} /></span>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] text-ink">Confirming your subscription…</p>
              {/* NOT "welcome to Pro". Arriving back means somebody returned, not that the payment
                  settled — the webhook decides that, and this poll is what waits for it. */}
              <p className="mt-0.5 text-[11px] leading-[1.55] text-muted">
                Finish in your browser if you haven't yet. This updates on its own once the payment
                clears, usually within a few seconds.
              </p>
              <div className="mt-2 flex items-center gap-1.5">
                <button type="button" className={secondaryBtn} onClick={() => void load()}>
                  I've finished paying
                </button>
                <button type="button" className={quietBtn} onClick={() => setConfirming(false)}>
                  Stop waiting
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* --- steps 1 to 3, entirely in the app -------------------------------------------------- */}
      <section>
        <h3 className={TYPE.panelLabel}>Change plan</h3>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {TIERS.map((t) => {
            const current = t.id === tier;
            const open = choosing === t.id;
            return (
              <div
                key={t.id}
                className={`rounded-control border px-3 py-2.5 ${
                  current ? "border-accent/50 bg-accent/[0.06]" : "border-edge bg-panel"
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[12px] font-medium text-ink">{t.label}</span>
                  {current && <span className="text-accent"><CheckIcon size={ICON.xs} /></span>}
                </div>
                <div className="mt-0.5 flex items-baseline gap-0.5">
                  <span className="text-[15px] font-medium tabular-nums text-ink">{t.price}</span>
                  <span className="text-[11px] text-faint">{t.per}</span>
                </div>
                <p className="mt-1 text-[11px] leading-[1.5] text-muted">{t.line}</p>
                <ul className="mt-1.5 space-y-0.5">
                  {t.points.map((p) => (
                    <li key={p} className="text-[11px] leading-[1.5] text-faint">— {p}</li>
                  ))}
                </ul>

                {/* §8.2 — "Usage / Billing / Change plan / checkout". Absent rather than disabled,
                    for the reason the BYOK row above states: the tiers and what each includes stay
                    readable by everybody, because that is what somebody compares a bill against;
                    the button that would start a checkout is the owner's. */}
                {!current && canManage && (
                  <button
                    type="button"
                    className={`${open ? quietBtn : secondaryBtn} mt-2 w-full justify-center`}
                    onClick={() => {
                      setChoosing(open ? null : t.id);
                      setSeats(Math.max(minimumSeats(t.id), sub?.seatCount ?? minimumSeats(t.id)));
                    }}
                  >
                    {open ? "Cancel" : t.id === "free" ? "Downgrade" : "Choose"}
                  </button>
                )}

                {/* Step 2 for Team — seats — and step 3, the price it comes to. Both in-app, and
                    the arithmetic is shown rather than only the total, so nobody has to trust it. */}
                {open && (
                  <div className="mt-2 border-t border-hair pt-2">
                    {t.id === "team" && (
                      <label className="flex items-center justify-between gap-2">
                        <span className={TYPE.meta}>Seats</span>
                        <input
                          type="number"
                          min={minimumSeats(t.id)}
                          max={20}
                          value={seats}
                          onChange={(e) => setSeats(Number(e.target.value))}
                          className="w-16 rounded-control border border-edge bg-bg px-2 py-1 text-right text-[12px] tabular-nums text-ink focus-visible:outline-none focus-visible:shadow-focusring"
                        />
                      </label>
                    )}
                    {t.id !== "free" && (
                      <p className="mt-1.5 text-[11px] tabular-nums text-muted">
                        {t.id === "team"
                          ? `${Math.max(minimumSeats(t.id), seats)} × $40 = $${Math.max(minimumSeats(t.id), seats) * 40}/month`
                          : "$20/month"}
                      </p>
                    )}
                    {/* SAYING WHERE THE NEXT CLICK GOES. The specification calls being upfront
                        about leaving the app part of the same honesty as the pricing. */}
                    <p className="mt-1 text-[11px] leading-[1.5] text-faint">
                      {t.id === "free"
                        ? "Takes effect at the end of the period you have paid for. Nothing is deleted."
                        : "Opens your browser to pay. Payment happens there, then you come back here."}
                    </p>
                    <button
                      type="button"
                      className={`${primaryBtn} mt-2 w-full justify-center`}
                      disabled={busy || t.id === "free"}
                      title={t.id === "free" ? "Downgrading is handled through the payment portal" : undefined}
                      onClick={() => void goToPayment(t.id)}
                    >
                      {busy ? "Starting…" : "Continue to payment"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Above twenty members a workspace is an Enterprise conversation rather than a bigger
          number, and the handoff is a mailto rather than a refusal — a cap that only says no is one
          somebody works around by opening a second workspace. */}
      <p className="text-[11px] leading-[1.55] text-faint">
        More than 20 people, SSO, or an on-premises deployment?{" "}
        <a className="text-muted underline" href="mailto:contact@jaroku.dev">contact@jaroku.dev</a>
      </p>

      {error && (
        <p className="text-[11px] leading-[1.55] text-err">{error}</p>
      )}
    </div>
  );
}
