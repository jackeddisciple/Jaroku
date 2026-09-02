# Component inventory

Grouped by category. For each component: source, purpose, where used, variants, states,
interactions, and — where it matters — **whether it is a new component or a reuse**, and whether a
reused component behaves identically in both places.

> **A component reused with different behaviour is a finding.** Those are marked ⚠ and repeated in
> [`../findings/inconsistencies.md`](../findings/inconsistencies.md).

| File | Covers |
|---|---|
| [`navigation.md`](navigation.md) | rail, sidebar, tabs, pointers |
| [`actions.md`](actions.md) | buttons, split buttons, menu items, destructive controls |
| [`inputs.md`](inputs.md) | the composer and its two variants, fields, selects, checkboxes |
| [`overlays.md`](overlays.md) | dialogs, popovers, drawers, the palette |
| [`containers.md`](containers.md) | cards, panels, collapsible regions, resizable panes |
| [`data-display.md`](data-display.md) | rows, chips, badges, glyphs, sparklines, stat rows, truncation |
| [`editors.md`](editors.md) | code viewer, diffs, state editing, dataset builder |
| [`agent-components.md`](agent-components.md) | agent cards, tabs, versions, files, art |
| [`run-components.md`](run-components.md) | trace timeline, steps, graph, pause/resume |
| [`cockpit-components.md`](cockpit-components.md) | everything the Cockpit introduced |
| [`feedback.md`](feedback.md) | toasts, banners, notices, empty states, live regions |

## The one rule the whole client holds to

**A control a role cannot use is ABSENT from the DOM, not disabled and not hidden.** `Capable.tsx`
is that rule as a component, and it states its own reasoning:

> a disabled control is an offer being refused, which invites a person to work out what would enable
> it and tells them the feature exists in their workspace when the answer is that it exists for
> somebody else; a control hidden with CSS is one devtools panel away from being clicked, and the
> click reaches the relay. **Absent is the only one of the three that is true.**

The Cockpit's own spec **overrides this** for its verbs (`cockpitCopy.ts:294-308`) — an operator who
cannot see that Stop exists concludes the product cannot stop a job. Two of the five Cockpit verbs
follow the override; three still deny by absence. See the findings.
