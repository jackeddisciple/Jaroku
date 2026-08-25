// §13 — the section that matters most, and the only one that is not about Jaroku.
//
// EVERY GRANT IN THE PEOPLE SECTION GOVERNS ACCESS **THROUGH** THIS PRODUCT. A deployed agent
// answers HTTP directly, on a URL anybody can hold, and the reviewed deployment template is
// Python's standard-library ThreadingHTTPServer with no auth layer of any kind. So the honest
// statement is that the deployed endpoint is not covered by anything above it in this panel — and
// an access panel that implies protection it does not provide is worse than no access panel,
// because it converts an unknown risk into a false certainty.
//
// THE SENTENCE COMES FROM THE SERVER AND IS PRINTED AS SENT. §13.1 rules out a pill — "a green/red
// pill invites skimming past the one fact that matters" — and a client that received a boolean
// would eventually draw one, because a boolean is a pill waiting to happen. So `exposure.auth` is
// prose, built where the deployment row is read, and this component's job is to put it on screen at
// a size somebody cannot skim.
//
// AND IT IS SHOWN WHEN NOTHING IS DEPLOYED. §13.2: a section that disappeared would have its
// absence read as safety, which is the one reading nobody should take from silence about what is on
// the internet.
//
// NO DEPLOY CONTROLS HERE. Both actions link to the Deploy tab, which already has redeploy, cancel
// and the streaming build log — §13.1 says not to duplicate deploy logic, and the reason is the one
// this repository gives everywhere: a second copy of a control is a second set of promises about
// what it does.

import { Truncate } from "./Truncate.tsx";
import { ExternalLinkIcon, GlobeIcon, RocketIcon } from "./panelIcons.tsx";
import { absTime, relTime } from "../lib/format.ts";
import { ICON, STATUS } from "../lib/tokens.ts";
import { useUiStore } from "../store/uiStore.ts";
import type { Exposure } from "../store/accessStore.ts";

export function AccessExposure({ exposure }: { exposure: Exposure | undefined }) {
  const setTab = useUiStore((s) => s.setRightTab);

  if (!exposure) {
    return <div className="text-tiny text-faint">Reading what is deployed…</div>;
  }

  if (!exposure.deployed) {
    // §13.2's single calm line. Calm on purpose: this is the good state, and a green tick here
    // would be the panel congratulating somebody for not having done something.
    return (
      <div className="flex items-start gap-2 text-tiny text-muted">
        <GlobeIcon size={ICON.xs} className="mt-0.5 shrink-0 text-faint" />
        <span>Not deployed — reachable only through Jaroku, by the people above.</span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {exposure.url ? (
        <a
          href={exposure.url}
          target="_blank"
          rel="noreferrer noopener"
          className="flex min-w-0 items-center gap-1.5 rounded-control border border-hair px-2.5 py-2 text-caption text-ink transition-colors hover:border-edge"
        >
          <Truncate className="min-w-0 flex-1">{exposure.url}</Truncate>
          <ExternalLinkIcon size={ICON.xs} className="shrink-0 text-faint" />
        </a>
      ) : (
        // NEVER A GUESS AT WHAT THE URL WILL BE — the deploy store is explicit about this, and a
        // section about reachability is the last place to invent an address.
        <div className="text-tiny text-faint">
          Deployed, and the host has not issued a URL yet.
        </div>
      )}

      {/* THE ONE FACT THAT MATTERS, as a sentence rather than a badge, at the size of the thing it
          is about. §13.1 in one element. */}
      <p
        className="rounded-control border border-hair px-2.5 py-2 text-caption leading-[1.55]"
        style={{ color: STATUS.error }}
      >
        {exposure.auth}
      </p>

      <div className="text-tiny text-faint">
        {/* NULL IS UNRECORDED AND SAYS SO. Migration 061 is never backfilled, so a deploy made
            before the column existed names nobody rather than naming the workspace's owner — a name
            beside a public URL that nobody actually chose to publish is worse than an honest gap. */}
        {exposure.deployedByName ? `Deployed by ${exposure.deployedByName}` : "Deployed by somebody unrecorded"}
        {exposure.deployedAt && (
          <span title={absTime(exposure.deployedAt)}> · {relTime(exposure.deployedAt)}</span>
        )}
        {exposure.version !== null && <span> · from v{exposure.version}</span>}
      </div>

      {/* §13.1's two actions, both of which are LINKS to the Deploy tab rather than controls. */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setTab("deploy")}
          className="flex items-center gap-1.5 rounded-control border border-hair px-2 py-1 text-tiny text-muted transition-colors hover:border-edge hover:text-ink"
        >
          <RocketIcon size={ICON.xs} /> View deploy
        </button>
        <button
          type="button"
          onClick={() => setTab("deploy")}
          className="flex items-center gap-1.5 rounded-control border border-hair px-2 py-1 text-tiny text-muted transition-colors hover:border-edge hover:text-ink"
          // THE WORDS ARE HONEST ABOUT WHERE THIS GOES. A "Take down" that opened another tab
          // rather than taking anything down would be a button lying about itself, so the tooltip
          // says what happens and the Deploy tab is where the act is.
          title="Opens the Deploy tab, where the deployment can be cancelled or taken down"
        >
          Take down
        </button>
      </div>
    </div>
  );
}
