// §3.1's grid, in the order it lays it out. The one file that decides where things are.
//
// THREE RHYTHMS, ONE GRID, USED IN SEQUENCE:
//
//     greeting · workspace          [24h 7d 30d]     header
//     SPEND      TOKENS   RUN HEALTH                 hero, 3-up
//     WORKSPACE PULSE — runs and spend over the range   wide band
//     AGENT LEADERBOARD          MODEL MIX           2-up
//     EVENT FEED                 RELEASES            2-up
//     TOOL & MCP USAGE           TEAM PULSE          2-up
//
// SEPARATE FROM `ActivityView`, WHICH OWNS THE SHELL, so the layout can be read without the header,
// the range control, the reconnect handling and the storage read around it. The shell is a mechanism
// and this is a composition; keeping them apart is what let the shell land in a commit of its own
// with the cards arriving after it.
//
// NARROW IS ONE COLUMN, WITH ONE EXCEPTION (§3.8). Everything stacks in the order above except the
// hero row, which stays three-across and merely gets compact — three numbers fit on a phone. That is
// why the hero is a `grid-cols-3` with no responsive prefix while every pair below it is
// `md:grid-cols-2`: the exception is expressed by the ABSENCE of a breakpoint rather than by a
// media query that has to be remembered.

import { ActivityView } from "./ActivityView.tsx";

export function ActivityDashboard() {
  return (
    <ActivityView>
      {/* The hero row. Three numbers, always three across — see §3.8. The cards themselves land in
          the commit after this one; the grid is what has to exist first, so that when they arrive
          they arrive into their final positions rather than into a layout that moves under them. */}
      <div className="grid grid-cols-3 gap-4" data-activity-region="hero" />

      {/* The wide band. One row, full width, because a time series read against a two-thirds column
          is a time series with half the resolution. */}
      <div data-activity-region="pulse" />

      {/* Three pairs, in §3.1's order. `md:` and not `lg:`: the breakpoint that matters here is the
          one where two cards of numbers stop fitting side by side, which is well below a laptop. */}
      <div className="grid gap-4 md:grid-cols-2" data-activity-region="leaderboard-mix" />
      <div className="grid gap-4 md:grid-cols-2" data-activity-region="feed-releases" />
      <div className="grid gap-4 md:grid-cols-2" data-activity-region="tools-team" />
    </ActivityView>
  );
}
