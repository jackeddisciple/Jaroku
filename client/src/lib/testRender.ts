// Rendering a component to markup from a suite, with the stores saying what the suite needs.
//
// WHY THIS EXISTS RATHER THAN `useSessionStore.setState`, which is the obvious thing to reach for
// and does not work. `renderToStaticMarkup` is a SERVER render, and React's `useSyncExternalStore`
// takes three arguments — subscribe, `getSnapshot`, `getServerSnapshot` — using the third one when
// there is no DOM. Zustand v5 passes `api.getInitialState` as that third argument, so a component
// rendered this way reads the object the store was CREATED with and never the one `setState` has
// been writing to. The symptom is a suite that seeds a signed-in session, renders, and gets the
// signed-out branch — which looks like the component being wrong and is not.
//
// SO THE INITIAL OBJECT IS WHAT GETS SEEDED, in place. `getInitialState()` returns it, mutating it
// keeps its identity stable — which `useSyncExternalStore` requires of a server snapshot, or React
// re-renders forever — and `setState` is called too so that anything reading through an ACTION
// (`role()` reads `get()`, not the snapshot) sees the same thing. Two writes, one truth.
//
// WHY NOT jsdom. A real DOM would make `setState` work and would cost a dependency whose whole job
// is to be a browser that is not one. §14.1 asks for "a structural test, not a click test", and a
// structural test is exactly the kind that does not need events, layout or a document — it needs
// the markup, which `react-dom/server` produces from the same components the browser runs.
//
// WHAT THIS CANNOT DO, stated so nobody spends an afternoon on it: effects do not run, so anything
// a component fetches or subscribes to on mount is absent from the markup, and nothing here can
// click. A suite that needs either of those is asking for a different tool.

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/** Enough of a zustand store for this file. Avoids importing its generics for two calls. */
interface Seedable {
  getInitialState: () => object;
  setState: (partial: object) => void;
}

/**
 * Put `state` into a store so that both a server render and an action can see it.
 *
 * IT MUTATES AND DOES NOT REPLACE, which is the constraint rather than a preference — see the
 * header. A fresh object would be a new server snapshot on every render.
 */
export function seed(store: unknown, state: object): void {
  const s = store as Seedable;
  Object.assign(s.getInitialState(), state);
  s.setState(state);
}

/** The markup a component produces right now. No browser, no jsdom, no click. */
export function markup(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

/**
 * A session for one role in one workspace, which is what almost every guard reads.
 *
 * `role` IS ON THE MEMBERSHIP, NOT ON THE USER, because that is where it lives: `sessionStore.
 * role()` finds the workspace by id and reads the role off it, so a suite that set a role anywhere
 * else would be testing its own fixture.
 */
export function sessionAs(
  role: string,
  options: { kind?: "personal" | "team"; name?: string; plan?: string } = {},
): object {
  const kind = options.kind ?? "team";
  return {
    status: "ready",
    user: {
      id: "u-test",
      email: "tester@example.com",
      displayName: "Tester",
      onboarded: true,
      onboardingStep: 5,
      isAdmin: false,
      adminMode: false,
    },
    workspaceId: "ws-test",
    workspaces: [
      {
        id: "ws-test",
        slug: "ws-test",
        name: options.name ?? "Acme Corp",
        kind,
        role,
        plan: { id: (options.plan ?? "Free").toLowerCase(), label: options.plan ?? "Free" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    switching: null,
    switchError: null,
  };
}
