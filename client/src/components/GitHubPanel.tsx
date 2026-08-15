// Two lineages, reconciled — the GitHub tab.
//
// Jaroku already has a version lineage. Git has one too. This panel is not "git inside Jaroku";
// it is the place where the relationship between the two is legible at every moment, and every
// region below answers one question: what does GitHub have that I do not, and what do I have that
// GitHub does not.
//
// THE REGION ORDER IS IDENTITY → VERDICT → ACTION → CONTEXT, and it is deliberate: the most common
// question anybody brings to this tab is "am I okay?", and it is answered in the second region
// without scrolling. Everything below the verdict exists to explain it.
//
// WHAT THIS FILE HOLDS AND WHAT IT DOES NOT. It renders; it never decides. The badge, the verdict
// sentence, the ahead and behind counts, the protected path list and the split between pushed and
// unpushed all arrive from the server, computed once, in `githubService.ts`. A second
// implementation here would be a second opinion — in a language whose `null` and `0` are easier to
// confuse than the one that produced them — and the day the two disagree the user is reading the
// one that is wrong.
//
// Everything visual is borrowed rather than invented: ActionRow for a narrative line, Chip for a
// sha, DiffStat for the figures, EmptyState for the two empty states, and the same three button
// weights the rest of the app uses. A push row should read like every other action row in the app,
// because it is one.

import { useEffect, useRef, useState } from "react";

import {
  sendCheckGithubRepo, sendLinkGithub, sendListGithub, sendListGithubRepos, sendRefreshGithub,
  sendUnlinkGithub,
} from "../lib/socket.ts";
import { connectGithub, disconnectGithub } from "../lib/secrets.ts";
import { ICON, STATUS } from "../lib/tokens.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { readRegions, useGithubStore, viewFor, writeRegions, type RegionId } from "../store/githubStore.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { relTime } from "../lib/format.ts";
import type { GithubVersionRow, GithubView } from "../types.ts";
import { ActionRow } from "./ActionRow.tsx";
import { DiffStat } from "./DiffStat.tsx";
import { CollapsibleRegion } from "./CollapsibleRegion.tsx";
import { GitHubCommitBox } from "./GitHubCommitBox.tsx";
import { GitHubSyncRegion, RegionLabel } from "./GitHubSync.tsx";
import { BranchSwitcher, ChangesRegion, HistoryRegion, PullRequestCard } from "./GitHubHistory.tsx";
import { primaryBtn, quietBtn } from "./buttons.ts";
import { Chip } from "./Chip.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { Truncate } from "./Truncate.tsx";
import { CheckIcon, GithubIcon, KebabIcon, SearchIcon, XIcon } from "./panelIcons.tsx";

export function GitHubPanel() {
  // Field by field rather than the whole store, for the reason DeployPanel gives at length: a
  // subscription with no selector re-renders on ANY change, and during a push this store changes
  // once per stage.
  const loaded = useGithubStore((s) => s.loaded);
  const connected = useGithubStore((s) => s.connected);
  const views = useGithubStore((s) => s.views);
  const error = useGithubStore((s) => s.error);
  const notice = useGithubStore((s) => s.notice);
  const setError = useGithubStore((s) => s.setError);
  const setNotice = useGithubStore((s) => s.setNotice);
  const agentId = useBuildStore((s) => s.activeAgentId);
  const view = viewFor(views, agentId);

  // Ask on mount and whenever the agent changes. McpPanel's precedent: relying only on the connect
  // snapshot means opening the tab after a reconnect shows whatever was true before it.
  useEffect(() => {
    sendListGithub(agentId ?? undefined);
  }, [agentId]);

  // AND RE-READ THE REMOTE, once, when a linked agent is opened. `refreshGithub` moves what we last
  // SAW and never what we last DID, so it cannot make unpushed work look pushed — which is what
  // makes it safe to fire on open rather than only on a click. Without it the verdict is as old as
  // the last thing that happened to touch this agent, which for a repository a teammate is editing
  // is exactly the number that is wrong.
  useEffect(() => {
    if (agentId && view) sendRefreshGithub(agentId);
    // Deliberately keyed on whether a link EXISTS rather than on the view object, which changes on
    // every snapshot — including the one this fires.
  }, [agentId, Boolean(view)]);

  if (!loaded) {
    // Not a spinner: "we have not been told yet" is a real state, and showing the connect screen
    // before the first snapshot would invite somebody to link an agent that is already linked.
    return <EmptyState icon={GithubIcon} title="Loading…" />;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {(error || notice) && (
        <div className="shrink-0 px-4 pt-2">
          <div
            className={`flex items-start gap-2 rounded-control border px-2 py-1.5 text-[11px] leading-[1.5] ${
              error ? "border-err/30 text-err" : "border-hair text-muted"
            }`}
          >
            <span className="min-w-0 flex-1 break-words">{error ?? notice}</span>
            <button
              className="shrink-0 text-faint hover:text-ink"
              onClick={() => (error ? setError(null) : setNotice(null))}
            >
              <XIcon size={ICON.xs} />
            </button>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {!connected ? (
          <NotConnected />
        ) : !agentId ? (
          <EmptyState
            icon={GithubIcon}
            title="No agent selected"
            hint="Pick an agent and Jaroku will show you what GitHub has that it does not."
          />
        ) : !view ? (
          <RepoPicker agentId={agentId} />
        ) : (
          <Linked view={view} />
        )}
      </div>
    </div>
  );
}

// --- §2.1 not connected -----------------------------------------------------

/**
 * The pitch, and the scope of access, in the same breath.
 *
 * THE PERMISSION SENTENCE IS IN THE EMPTY STATE RATHER THAN BEHIND A TOOLTIP. For a product whose
 * pitch is trust, what it is about to be allowed to do is part of the pitch — and a tooltip is a
 * place to put something you would rather people did not read.
 *
 * A PASTED TOKEN RATHER THAN AN OAUTH REDIRECT, and that is the honest shape today: the token goes
 * one way, over HTTPS, into the vault, and what comes back is the account login. An OAuth app would
 * be a nicer front door and would land on the identical storage, which is why the panel is written
 * against `connectGithub()` rather than against a flow.
 */
function NotConnected() {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const value = token.trim();
    if (!value || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await connectGithub(value);
      // Cleared the instant it leaves. The field is the only copy in this tab and it has served
      // its purpose; leaving a credential sitting in a DOM node is a habit worth not having.
      setToken("");
      sendListGithub();
    } catch (err) {
      setProblem((err as Error)?.message ?? "GitHub refused that token");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4">
      <EmptyState
        icon={GithubIcon}
        title="Your agent's code, in your repo"
        hint="Every version you apply becomes a commit. Jaroku pushes. You own the repo."
        size="inline"
      />
      <div className="mx-auto mt-1 max-w-[42ch]">
        <div className="flex items-center gap-2">
          <input
            type="password"
            autoComplete="off"
            className="min-w-0 flex-1 rounded-control bg-panel px-2 py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-faint"
            placeholder="GitHub personal access token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
          <button className={primaryBtn} disabled={!token.trim() || busy} onClick={() => void submit()}>
            {busy ? "Checking…" : "Connect GitHub"}
          </button>
        </div>
        {problem && (
          <p className="mt-1.5 text-[11px] leading-[1.5] text-err">{problem}</p>
        )}
        {/* The scope of access, stated. See the note above. */}
        <p className="mt-2 text-[11px] leading-[1.55] text-faint">
          Needs <span className="font-mono">repo</span> scope — read and write to the repositories
          you select, and nothing else. The token goes straight into Jaroku's vault behind the
          Secrets passcode, is never logged, and never comes back to this page. Revoke it any time
          from GitHub settings, or disconnect here.
        </p>
      </div>
    </div>
  );
}

// --- §2.2 choosing a repo ---------------------------------------------------

/**
 * Create a new repository, or point at one that exists.
 *
 * SUBDIRECTORY IS IN ADVANCED RATHER THAN ABSENT. Teams keeping several agents in one monorepo need
 * `agents/weather/` rather than a repository root — cheap to support now, painful to retrofit,
 * and hidden behind a disclosure because most people will never touch it.
 *
 * THE AVAILABILITY CHECK IS DEBOUNCED AND ITS ANSWER IS MATCHED AGAINST THE FIELD. Answers arrive
 * over a socket, in whatever order the network delivers them, so a stale one for a prefix the user
 * has already typed past would flash "taken" under a name that is free. Comparing the name back is
 * what makes the check honest rather than merely fast.
 */
function RepoPicker({ agentId }: { agentId: string }) {
  const [mode, setMode] = useState<"create" | "existing">("create");
  const [name, setName] = useState(agentId.replace(/_/g, "-"));
  const [isPrivate, setPrivate] = useState(true);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [branch, setBranch] = useState(`jaroku/${agentId}`);
  const [subdirectory, setSubdirectory] = useState("");
  const [includeArtifacts, setIncludeArtifacts] = useState(true);

  const accountLogin = useGithubStore((s) => s.accountLogin);
  const repos = useGithubStore((s) => s.repos);
  const reposLoading = useGithubStore((s) => s.reposLoading);
  const nameCheck = useGithubStore((s) => s.nameCheck);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (mode !== "existing" || repos.length > 0) return;
    sendListGithubRepos();
  }, [mode, repos.length]);

  useEffect(() => {
    if (mode !== "create") return;
    if (timer.current) clearTimeout(timer.current);
    const value = name.trim();
    if (!value) return;
    // 350ms: long enough that typing `weather-agent` is one request rather than thirteen, short
    // enough that the answer arrives while the field still has focus.
    timer.current = setTimeout(() => sendCheckGithubRepo(value), 350);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [name, mode]);

  const trimmedName = name.trim();
  // Only trust an answer that is about what is in the field RIGHT NOW — see the note above.
  const availability = nameCheck && nameCheck.name === trimmedName ? nameCheck.available : null;
  const filtered = query.trim()
    ? repos.filter((r) => r.fullName.toLowerCase().includes(query.trim().toLowerCase()))
    : repos;
  const canLink = mode === "create" ? Boolean(trimmedName) && availability !== false : Boolean(chosen);

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <span style={{ color: STATUS.ok }}><CheckIcon size={ICON.xs} /></span>
        <span className="font-mono text-[12px] text-ink">@{accountLogin}</span>
        <button
          className={`${quietBtn} ml-auto`}
          title="Forgets the token. Every agent's link stays, and nothing in your GitHub account is touched."
          onClick={() => {
            void disconnectGithub().then(() => sendListGithub(agentId));
          }}
        >
          Sign out
        </button>
      </div>

      <div>
        <ModeRow selected={mode === "create"} onSelect={() => setMode("create")} label="Create new repo" />
        {mode === "create" && (
          <div className="mt-1.5 pl-5">
            <div className="flex items-center gap-2">
              <input
                className="min-w-0 flex-1 rounded-control bg-panel px-2 py-1.5 font-mono text-[12px] text-ink outline-none placeholder:text-faint"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="weather-agent"
              />
              <select
                className="rounded-control bg-panel px-2 py-1.5 text-[11px] text-ink outline-none"
                value={isPrivate ? "private" : "public"}
                onChange={(e) => setPrivate(e.target.value === "private")}
              >
                <option value="private">Private</option>
                <option value="public">Public</option>
              </select>
            </div>
            <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-faint">
              <Truncate title={`github.com/${accountLogin}/${trimmedName}`}>
                github.com/{accountLogin}/{trimmedName}
              </Truncate>
            </div>
            {/* THREE STATES, NOT TWO. Unknown is what it says while the debounce is waiting, and
                rendering it as "available" would show a green tick under a name nobody has asked
                about yet. */}
            {trimmedName && (
              <div className={`mt-1 text-[11px] ${availability === false ? "text-err" : availability ? "text-ok" : "text-faint"}`}>
                {availability === null ? "checking…" : availability ? "✓ available" : "that name is taken"}
              </div>
            )}
          </div>
        )}
      </div>

      <div>
        <ModeRow selected={mode === "existing"} onSelect={() => setMode("existing")} label="Use existing repo" />
        {mode === "existing" && (
          <div className="mt-1.5 pl-5">
            <div className="flex items-center gap-2 rounded-control bg-active px-2.5 py-1.5">
              <span className="shrink-0 text-faint"><SearchIcon size={ICON.xs} /></span>
              <input
                className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-faint"
                placeholder="Search your repos…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="mt-1.5 max-h-48 space-y-0.5 overflow-auto">
              {reposLoading && repos.length === 0 ? (
                <p className="text-[11px] text-muted">reading your repositories…</p>
              ) : filtered.length === 0 ? (
                // The list is already filtered server-side to repositories this token can WRITE
                // to — offering a read-only one would produce a link whose first push fails.
                <p className="text-[11px] text-muted">
                  {repos.length === 0 ? "no repositories this token can write to" : "nothing matches"}
                </p>
              ) : (
                filtered.map((r) => (
                  <button
                    key={r.fullName}
                    onClick={() => setChosen(r.fullName)}
                    className={`flex w-full items-center gap-2 rounded-control px-2 py-1 text-left text-[12px] transition-colors duration-fast ${
                      chosen === r.fullName ? "bg-active text-ink" : "text-muted hover:bg-active/40 hover:text-ink"
                    }`}
                  >
                    <span className="inline-flex w-[11px] shrink-0 items-center justify-center" aria-hidden>
                      {chosen === r.fullName && <CheckIcon size={ICON.xs} />}
                    </span>
                    <Truncate className="min-w-0 flex-1 font-mono" title={r.fullName}>{r.fullName}</Truncate>
                    {r.private && <Chip size="sm" tone="faint" caps>private</Chip>}
                    {r.empty && <Chip size="sm" tone="faint" caps title="No commits yet — the first push creates them">empty</Chip>}
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-hair pt-3">
        <button className={quietBtn} onClick={() => setAdvanced((v) => !v)}>
          {advanced ? "▾" : "▸"} Advanced
        </button>
        {advanced && (
          <div className="mt-1.5 space-y-2 pl-3">
            <Field label="Branch" value={branch} onChange={setBranch} mono />
            <Field
              label="Subdirectory"
              value={subdirectory}
              onChange={setSubdirectory}
              placeholder="/ (repository root)"
              mono
            />
            <label className="flex cursor-pointer items-start gap-2 text-[11px] text-muted">
              <input
                type="checkbox"
                className="mt-0.5 shrink-0"
                checked={includeArtifacts}
                onChange={(e) => setIncludeArtifacts(e.target.checked)}
              />
              <span className="min-w-0 flex-1">
                Include Dockerfile &amp; pyproject
                <span className="block text-faint">
                  What the deploy layer already synthesises for this agent, so the pushed repo is
                  deploy-ready rather than source-only.
                </span>
              </span>
            </label>
            {/* Jaroku owns `jaroku/<slug>` and never writes to a default branch on its own — §3.1.
                A user pointing this at `main` is their repository and their decision, and nothing
                here proposes it. */}
            <p className="text-[11px] leading-[1.5] text-faint">
              Jaroku pushes to this branch and never to your default one. Reconciliation is always
              through a pull request.
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center border-t border-hair pt-3">
        <button
          className={`${primaryBtn} ml-auto`}
          disabled={!canLink}
          onClick={() =>
            sendLinkGithub({
              agentId,
              ...(mode === "existing" ? { repoFullName: chosen ?? "" } : { createName: trimmedName, createPrivate: isPrivate }),
              branch: branch.trim() || undefined,
              subdirectory: subdirectory.trim() || null,
              includeArtifacts,
            })
          }
        >
          Link repository
        </button>
      </div>
    </div>
  );
}

function ModeRow({ selected, onSelect, label }: { selected: boolean; onSelect: () => void; label: string }) {
  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-center gap-2 text-left text-[12px] transition-colors duration-fast ${
        selected ? "text-ink" : "text-muted hover:text-ink"
      }`}
    >
      {/* A fixed slot, so choosing does not shift the row — the same rule the model selector's
          check column follows. */}
      <span className="inline-flex w-3 shrink-0 items-center justify-center" aria-hidden>
        {selected ? "●" : "○"}
      </span>
      {label}
    </button>
  );
}

function Field({
  label, value, onChange, placeholder, mono = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-[11px] text-muted">
      <span className="w-[86px] shrink-0">{label}</span>
      <input
        className={`min-w-0 flex-1 rounded-control bg-panel px-2 py-1 text-[11px] text-ink outline-none placeholder:text-faint ${mono ? "font-mono" : ""}`}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/**
 * The linked panel: identity, then verdict, then the two version lists.
 *
 * §1's region order, and it is deliberate — identity, verdict, action, context. "Am I okay?" is
 * answered in the second region without scrolling; everything under it explains that answer.
 */
function Linked({ view }: { view: GithubView }) {
  const workspaceId = useSessionStore((s) => s.workspaceId);
  // Read once per agent rather than on every render: this is localStorage, the panel re-renders on
  // every stage of a push, and a synchronous read per frame during a live rail is a read per frame
  // for a value that only a click changes.
  const [regions, setRegions] = useState(() => readRegions(workspaceId, view.agentId));
  useEffect(() => {
    setRegions(readRegions(workspaceId, view.agentId));
  }, [workspaceId, view.agentId]);

  const toggle = (id: RegionId) => () => {
    const next = { ...regions, [id]: !regions[id] };
    setRegions(next);
    writeRegions(workspaceId, view.agentId, next);
  };

  return (
    <div className="space-y-4 p-4">
      {/* REPO HEADER and SYNC STATE omit the count slot rather than showing a fake 1 — §A.5. An
          empty count column reads as "not applicable"; a 1 reads as "one of something". */}
      <CollapsibleRegion label="Repository" open={regions.header} onToggle={toggle("header")}>
        <RepoHeader view={view} />
      </CollapsibleRegion>

      <CollapsibleRegion label="Sync state" open={regions.sync} onToggle={toggle("sync")}>
        <GitHubSyncRegion view={view} />
      </CollapsibleRegion>

      <CollapsibleRegion
        label="Changes"
        // The number of items the section's own action operates over — files, not versions.
        count={view.changes.filter((c) => !c.locked).length}
        open={regions.changes}
        onToggle={toggle("changes")}
      >
        <ChangesRegion view={view} />
        {/* §3.4's commit box sits under the file list rather than above it: the message is written
            about what is in that list, and asking somebody to compose before they have looked is
            the wrong order. */}
        {view.changes.some((c) => !c.locked) && (
          <div className="mt-3 border-t border-hair pt-3">
            <GitHubCommitBox view={view} />
          </div>
        )}
        <div className="mt-4">
          <VersionLists view={view} />
        </div>
      </CollapsibleRegion>

      <CollapsibleRegion
        label="History"
        // Versions AND commits combined, because the section renders one interleaved column and a
        // count of only half of it would disagree with what expanding shows.
        count={view.unpushed.length + view.pushed.length + view.remoteOnly.length}
        open={regions.history}
        onToggle={toggle("history")}
      >
        <PullRequestCard view={view} />
        <div className="mt-4">
          <HistoryRegion view={view} />
        </div>
      </CollapsibleRegion>
    </div>
  );
}

/** §1's first region: what this agent is linked to, and the way out of it. */
function RepoHeader({ view }: { view: GithubView }) {
  const [menu, setMenu] = useState(false);
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-ink"><GithubIcon size={ICON.sm} /></span>
        <a
          className="min-w-0 flex-1 font-mono text-[12px] text-ink hover:underline"
          href={view.repoUrl}
          target="_blank"
          rel="noreferrer"
        >
          <Truncate title={view.link.repo_full_name}>{view.link.repo_full_name}</Truncate>
        </a>
        <button className={`${quietBtn} shrink-0`} onClick={() => setMenu((v) => !v)} title="Link options">
          <KebabIcon size={ICON.xs} />
        </button>
      </div>
      <div className="mt-0.5 flex items-center gap-2 pl-6 font-mono text-[11px] text-muted">
        <BranchSwitcher view={view} />
        {view.link.subdirectory && (
          <Chip size="sm" tone="faint" mono variant="bare" title="Only this directory is pushed and pulled">
            {view.link.subdirectory}/
          </Chip>
        )}
      </div>
      {menu && (
        <div className="mt-2 rounded-control border border-hair p-2">
          {/* Said before the button rather than after it. §6's rule is absolute — Jaroku never
              deletes a user's repository — and the only way somebody knows that before clicking is
              if it is written where the click is. */}
          <p className="text-[11px] leading-[1.5] text-muted">
            Unlinking stops Jaroku pushing here. The repository, the branch and every commit
            already on it are untouched.
          </p>
          <button
            className={`${quietBtn} mt-1 !text-err`}
            onClick={() => {
              sendUnlinkGithub(view.agentId);
              setMenu(false);
            }}
          >
            Unlink repository
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * §2.3: versions as commits, in two lists.
 *
 * UNPUSHED FIRST, because it is the list with something to do in it. A pushed version is a
 * finished thing; an unpushed one is the reason the badge is showing a number.
 *
 * Rows are ActionRow with DiffStat trailing figures — the existing narrative-line pattern — so a
 * push row reads like every other action row in the app rather than like a git client bolted on.
 * Commit shas are Chip monospace, linking out.
 */
function VersionLists({ view }: { view: GithubView }) {
  return (
    <div className="space-y-4">
      {view.unpushed.length > 0 && (
        <section>
          <RegionLabel>
            Unpushed
            <span className="ml-2 font-normal normal-case tracking-normal text-faint">
              {view.unpushed.length}
            </span>
          </RegionLabel>
          <div className="mt-1.5">
            {view.unpushed.map((v) => <VersionRow key={v.id} row={v} />)}
          </div>
        </section>
      )}

      {view.pushed.length > 0 && (
        <section>
          <RegionLabel>
            Pushed
            <span className="ml-2 font-normal normal-case tracking-normal text-faint">
              {view.pushed.length}
            </span>
          </RegionLabel>
          <div className="mt-1.5">
            {view.pushed.map((v) => <VersionRow key={v.id} row={v} />)}
          </div>
        </section>
      )}

      {view.unpushed.length === 0 && view.pushed.length === 0 && (
        <EmptyState
          size="inline"
          icon={GithubIcon}
          title="No versions yet"
          hint="Generate or edit this agent and the version becomes a commit here."
        />
      )}
    </div>
  );
}

function VersionRow({ row }: { row: GithubVersionRow }) {
  return (
    <ActionRow
      kind={row.sha ? "done" : "wait"}
      state={row.sha ? "done" : "pending"}
      hideVerb
      lead={<span className="w-8 text-right font-mono text-[11px]">v{row.version}</span>}
      object={<span className="text-ink"><Truncate title={row.summary}>{row.summary}</Truncate></span>}
      detail={
        <span className="text-faint">
          {row.files} file{row.files === 1 ? "" : "s"} · {relTime(row.createdAt)}
        </span>
      }
      trailing={
        <>
          {(row.additions > 0 || row.deletions > 0) && (
            <DiffStat additions={row.additions} deletions={row.deletions} />
          )}
          {row.sha && row.shaUrl && (
            // A monospace chip that leaves for GitHub, which is the one thing a sha is for.
            <a href={row.shaUrl} target="_blank" rel="noreferrer" className="hover:underline">
              <Chip size="sm" tone="faint" mono variant="bare">{row.sha.slice(0, 7)}</Chip>
            </a>
          )}
        </>
      }
    />
  );
}
