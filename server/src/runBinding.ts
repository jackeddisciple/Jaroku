// A run's place in its workspace, held for as long as its credentials are being read.
//
// THE HOSTED SECRET STORE RELEASES NOTHING TO A RUN IT CANNOT PLACE. `getForRun(runId, names)` asks
// `runWorkspace(runId)` which workspace the run belongs to, and a run id that resolves to nothing
// gets nothing back — the one case where guessing would be a cross-tenant leak. index.ts answers
// that question from `runWorkspaces`, and every path that starts a run (fresh, resumed, branched,
// an eval's) recorded the run there only AFTER resolving its credentials. So on the hosted backend
// a run's own provider key, its required names and its connectors' values all came back empty: a
// desktop run was refused with "Add ANTHROPIC_API_KEY in the Secrets tab" while the key sat in
// Secrets, and a hosted run fell through to the platform's pool. The local `.env` store never asks
// where a run belongs, which is why none of it showed on a laptop.
//
// BOUND TO THE ASKING WORKSPACE, which is the binding the run is given moments later anyway, and
// released when the read is over — so a run refused before it starts leaves nothing behind. A run
// already bound (a resume of one still registered) is left exactly as it was.

/** Bind `runId` to `ctx` in `registry` unless it is bound already; returns the release. */
export function bindForCredentials<C>(registry: Map<string, C>, runId: string, ctx: C): () => void {
  if (registry.has(runId)) return () => {};
  registry.set(runId, ctx);
  // Every caller registers the run for real only after this read has finished and been released.
  return () => void registry.delete(runId);
}
