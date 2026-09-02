# Visual structure

## Composition, by area

| Area | Silhouette | Content width | Scrolling |
|---|---|---|---|
| Workspace shell | **four columns** — rail, sidebar, centre, right panel + tab rail | full window | each column scrolls independently |
| Threads | header · filter row · **day-grouped rows** | full pane | one column |
| Agents | header · **card grid** | full pane | one column |
| **Cockpit** | header · **horizontal card strip** · filter row · **day-grouped rows** · pinned composer | full pane | the strip scrolls x; the record scrolls y |
| Inbox | header · **lane rail + three columns of cards** | full pane | per lane |
| Activity | greeting · range switch · **a grid of figure-led cards** | full pane | one column |
| Right panel | a single column of sections | ~560px at 1440 | one column |
| Workspace panel | tab row · a single column | full overlay | one column |

**Six different silhouettes** in one product: a row list, a card grid, a board of lanes, a
figure-led dashboard, a console (strip + list + composer), and a settings stack.

## Where two areas that should look related do not

- **Threads and the Cockpit are both day-grouped row lists** and they look like different products.
  Threads has a full-width filter *field* above five counted chips; the Cockpit has no field, a
  scope toggle, and glyph chips. Threads rows are two lines (title over meta); Cockpit rows are one
  line of six columns. Both are "a list of things that happened, newest first, grouped by day".
- **The Inbox and the Cockpit both answer "what needs me"** and share no visual language: a board of
  cards in three lanes versus a table of rows under a strip.
- **Agent detail and the fleet card** describe the same agent and agree on almost nothing — one is a
  hero image over a stat grid, the other a 240px card carrying one composed sentence.

## Where two areas that should look different look the same

- **The build composer and the dispatch composer.** Same position, same box, same send affordance —
  and one proposes a discardable diff while the other spends money on a container in the world. The
  more consequential one has *fewer* controls.
- **`FIX <agent>`** heads both a build thread and an operate thread. See
  [`findings/inconsistencies.md`](findings/inconsistencies.md) §9.

## Hierarchy and density

| Surface | Density | Set by |
|---|---|---|
| Trace timeline | **highest** — deliberately pale step-type chips so it does not become a rainbow | `STEP_TYPE` |
| Cockpit work list | high — one line per job, six slots, tabular figures | `ROW_HEIGHT` |
| Threads / Inbox | medium — two lines per item | |
| Agents grid | low — cards with whitespace | |
| Activity | lowest — figure-led cards, large numerals, generous padding | |

The Cockpit sits at the dense end and the Activity dashboard at the sparse end, and they are two
clicks apart in the same rail.

## Regions and persistence

| Element | Persistent across | Notes |
|---|---|---|
| TopBar | every screen | agent identity + Deploy |
| Icon rail | every screen | never collapses, never loses its selection |
| Sidebar panel | every screen incl. full-screen destinations | **deliberately unchanged by the destination** |
| StatusBar | every screen | `● connected` · `N deployed` |
| Right panel | the three-pane view only | replaced by a full-screen destination |

## Sticky and fixed

| Element | Behaviour |
|---|---|
| Cockpit dispatch composer | pinned to the bottom of the pane |
| Build/operate composer | pinned to the bottom of the centre pane |
| Day-group headers | `LAYER.sticky` is defined for this; the Cockpit's groups scroll away |
| Filter bars | scroll with the content |
| The work detail panel | slides over bands 3–5; does not push them |

## Split and resizable areas

Two draggable seams: sidebar ↔ panes, and centre ↔ right panel. Both take a **measured pixel floor**
converted to a percentage against the parent's real width, because a percentage floor put the
composer's controls outside its own box at 1440px.

## Overlays

Ranked by `LAYER`: sticky 10 · panel 20 · menu 30 · overlay 40 · modal 50. See
[`components/overlays.md`](components/overlays.md).

## Graphs and figures

| Surface | Form |
|---|---|
| Activity SPEND | a figure + a **neutral share bar** with the series named beneath |
| Activity TOKENS | a figure + a sparkline |
| Activity WORKSPACE PULSE | columns (runs) + a line (spend), each named in the caption |
| Activity MODEL MIX | a share bar + a legend |
| Agent detail RECENT RUNS | a bar per run — *"click a bar to open its trace"* |
| Fleet card | a sparkline on line three |
| Usage | four meters, each a label / figure / ceiling / track |

Every bar chart in the product **names its series in text beside or beneath it**, which is what
allows the bars themselves to be neutral.

## Whitespace

The 4px grid is named by relationship rather than by number — `tight` 8 (within a group), `header`
10, `section` 20, `block` 24 (between two distinct moments). Naming the relationship is what keeps
the rhythm consistent across components applied by hand.

## Narrow behaviour

At the enforced minimum of **1024×680**:

- the four columns remain four columns
- the work list sheds **only** the failure sentence (`hidden md:block`); no other column sheds
- the detail panel takes roughly half the window and **covers** the columns rather than shedding them
- **the detail panel's own headings overprint each other** — see
  [`findings/ux-debt.md`](findings/ux-debt.md) §2

`window.rs:11-15` names Threads, Agents, Inbox and Activity as the destinations with a narrow-width
fallback. The Cockpit is not among them.
