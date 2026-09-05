// The one import surface for icons. Call sites import `Icon` from here and nothing else.
//
//   import { Icon } from "../lib/icons/registry.ts";
//
//   <IconButton icon={Icon.agents.fork} label="Fork agent" />
//   <IconButton icon={Icon.cockpitWork.retry} label="Retry this work item" />
//
// CALL SITES NAME ACTIONS, NEVER MARKS — invariant I4, and the reason this file exists rather than
// 150 imports of `GitForkIcon`. A component says what it is doing; `manifest.ts` says what that
// looks like. Deciding that "fork" should be drawn differently is then a one-line edit in one file,
// and a mark used in nine places cannot drift in eight of them. `test:icon-registry` fails any
// component that reaches past this file into `generated/`.
//
// TYPED SO AN UNKNOWN KEY IS A COMPILE ERROR. `Icon.agents.frok` does not render nothing at 3am —
// it fails `npm run typecheck`. That is the whole reason the registry is a mapped type over the
// manifest rather than a `Record<string, IconComponent>`.
//
// ── WHY THE COMPOSER'S GLYPHS ARE IN HERE TOO (D8) ─────────────────────────────────────────────
//
// icons_integration's appendix lists 104 marks and its acceptance asks for 104 generated
// components. There are 117. The extra 13 are the composer's control bar, its ⊕ menu and the turn
// rows beneath it, which drew through `@hugeicons/react` at their own stroke weight out of
// `components/icons.ts`.
//
// They had to move, because I2 says `@hugeicons/react` is not installed at all and the old file
// could not survive that. Leaving them behind would have meant either keeping a runtime icon
// dependency in the one bar that must render before anything else — failing I2 and
// `test:icon-deps` — or a second optical weight sitting inches from the first, which is the exact
// failure §0 says this product has already refused twice. So the count moved and the invariant
// held, which is the right way round. Recorded in the release notes as an eighth decision.

import type { ReactElement } from "react";

import type { IconProps } from "../../components/panelIcons.tsx";
import * as generated from "./generated/index.ts";
import { MANIFEST } from "./manifest.ts";

/** Every mark in the app has this shape, generated or hand-drawn. */
export type IconComponent = (p: IconProps) => ReactElement;

type Registry = {
  readonly [G in keyof typeof MANIFEST]: {
    readonly [K in keyof (typeof MANIFEST)[G]]: IconComponent;
  };
};

const marks = generated as unknown as Record<string, IconComponent | undefined>;

/**
 * Resolve the manifest's names against the generated barrel, once, at module load.
 *
 * The throw is not defensive programming — it is the last of the three gates that make a missing
 * mark impossible to ship. The generator refuses a name the package does not export, typecheck
 * refuses a key no manifest entry declares, and this refuses a manifest entry the generator has
 * not been re-run for. A blank square never reaches a screen through any of them.
 */
const resolved = Object.fromEntries(
  Object.entries(MANIFEST).map(([group, keys]) => [
    group,
    Object.fromEntries(
      Object.entries(keys as Record<string, string>).map(([key, name]) => {
        const mark = marks[name];
        if (!mark) {
          throw new Error(
            `icon registry: ${group}.${key} names "${name}", which is not in ` +
              `lib/icons/generated/. Run \`npm run gen:icons\`.`,
          );
        }
        return [key, mark];
      }),
    ),
  ]),
);

export const Icon = resolved as Registry;

/**
 * Every registry key as `group.key`, for the suites that assert both directions of I7 — no key
 * without a call site, and no control in the specification without a key.
 */
export const ICON_KEYS: readonly string[] = Object.entries(MANIFEST)
  .flatMap(([group, keys]) => Object.keys(keys).map((key) => `${group}.${key}`))
  .sort();
