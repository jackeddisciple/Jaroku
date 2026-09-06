# Decisions — agent avatars and identity

§10 of the brief asks for four decisions to be recorded with reasoning. They are here rather than in
a commit message because a commit message is read once, by the person who wrote it.

---

## D1 · Roster size

**Twenty-eight**, in §3's 24–40 band and near its bottom.

The count is bounded above by the **picker**, not by the renderer. Every entry has to be tellable
apart from every other at 96px, and past about thirty humanoids drawn from one part generator the
marginal character is a near-duplicate of one already there — it costs a row of the picker and buys
nothing. Below about twenty a mid-size workspace runs out of distinct faces, which is the failure
§3 names.

The candidate pool was seventy-seven, swept systematically across all eleven materials and every
allowed palette. It was cut on §3's four criteria in order, and two of the cuts were made by looking
rather than by rule:

- The closest pair on the first sheet was two pale blonde flocked spheres with their eyes shut.
  §3.1: two characters differing only in shade are one character. One was replaced.
- One candidate came out **ginger-haired**. Hair is a minority area so the palette rule does not see
  it, and at 96px in a grid whose cards carry amber for "running" it still read orange. Its seed was
  walked. This is the same kind of call as the five emoji withdrawn by hand, and it is written down
  in `roster.test.ts` for the same reason: so that adding one back is a decision somebody makes.

**All twenty-eight are `stance: "biped"`.** The head-only stance is upstream's house look for
creatures and it is wrong here — an agent card shows a worker, and a floating head reads as a mask.
`GLOSS_STANCES` keeps both because that is the runtime's vocabulary; the roster uses one, and the
suite asserts it.

Nineteen of the twenty-eight use the `skin` palette, which is the humanoid's own. The rest are pale
schemes that shift the skin tone rather than replace it. A sheet where a third of the faces are mint
is a novelty aisle, not a cast.

---

## D2 · The animating cap

**Twelve, and it has never been under real pressure on the machine it was measured on.**

The number matters less than the honesty about where it came from, which §10 is explicit about: "a
cap tuned on an M-series laptop is not a cap."

**The machine:** Apple Silicon Mac, macOS 15 (Darwin 25.6). Twenty-four agents, all on screen, one
`WebGLRenderer`, characters Catmull-Clark subdivided at `subdiv: 2`. At the default window the grid
shows nine to twelve cards, so the cap is **inactive in the ordinary case** and only engages on a
tall window or a fast scroll — which is the right place for a limit to sit.

**What is actually known, and what is not:**

- Build cost is the spike, not the steady state. A character costs roughly twenty milliseconds to
  subdivide; twenty at once on grid open is what `BUILD_BUDGET_MS` exists for, and eight
  milliseconds per frame fills a grid in a few hundred milliseconds without freezing it.
- The steady state is cheap here: one scissor pass per visible slot at 30 fps.
- **This has not been measured on a low-powered machine.** §9's last item — "an older laptop, or
  throttled CPU: this is the only honest test of §4.3" — has not been done, and the cap should be
  treated as provisional until it has. If it turns out to be wrong, `ANIMATING_CAP` is one constant
  in `lib/gloss/GlossBudget.ts` and the loop already ranks slots by distance from the centre, so
  lowering it degrades the edges of the grid first and nothing else.

---

## D3 · Gloss characters in a hairline monochrome UI

**Kept.** This is the largest visual change the product has taken and §10 is right that it cannot be
settled by reasoning — only by looking at a full grid. It was looked at, repeatedly, on a
twenty-four-agent workspace in the real application.

What made it work rather than fight everything around it was **not** the characters; it was three
decisions about how they are drawn:

1. **The wall became a shadow catcher.** Upstream's contact sheet hangs characters on an opaque warm
   taupe plane, because its page is that colour. Ported straight across, that is an opaque box per
   card — the first filled box in a product drawn in hairlines, twenty times on one screen. Swapping
   the wall's material for `ShadowMaterial` keeps the contact shadow that stops a character floating
   and loses the box: the card's own white shows through.
2. **No container around the avatar.** No ring, no tint, no rounded backdrop. The card already has a
   radius and an elevation.
3. **Size.** The character went to 112px centred on top at one point and it was wrong — it made the
   picture the hero and left a band of empty space above the name. At 64px beside the name it is the
   largest element on the card and still supports the name rather than replacing it.

**If it is wrong, the revert is commit 11 alone** — that remains true. The roster (commit 4) is data
and can be replaced without touching code; the renderer (5, 6, 7) compiles and ships nothing on its
own.

---

## D4 · Emoji retained

**Kept, as the small-size identity, per I4.**

The split is by SURFACE, not by mark: the sidebar, thread rows, Cockpit work rows and the command
palette wear the emoji; the Agents grid card and the agent detail header wear the character. "Not two
systems, one identity at two fidelities" — and it holds only because nothing tries to render 3D
small.

Two things changed during the work that are worth recording:

- **The emoji is now the avatar's placeholder.** `GlossAvatar` draws it inside the avatar box while
  the character is still in the build queue, and for ever on a machine with no WebGL. So a card that
  has not finished building shows the same mark the sidebar does, and a machine without a GPU shows
  the product minus one feature rather than a product with holes in it.
- **D6's live consequence is closed.** That decision recorded that the detail header said "the blue
  one" (a generated gradient band) and "the tractor" (the emoji) about one agent, and said the fix,
  if it ever mattered, was to retire the gradient. A third picture arriving made it matter. The band
  is gone; the header now carries one picture of the agent.

§10's suggestion — that a static avatar render might be legible at 20px, which would let the emoji
be retired for a single identity everywhere — was **not** tested and remains out of scope. The floor
this work actually set is 30px (`AVATAR_SIZE.compact`), and below about 40 the haircut and the
glasses that separate two characters stop separating anything.

---

## One thing §7 asks for that the default sidebar cannot show

Not a decision so much as a measured consequence, recorded because it is invisible until somebody
looks for it.

§7's line is `[emoji] Stacey — Billing`, with the name never truncating and the category taking what
is left. At the **default sidebar width** (20% of a 1440px window), the agent row's button is about
164px wide, and a status dot, a provider mark, the emoji and a typical name consume nearly all of it
— leaving under 44px, at which point the category is dropped rather than rendered as a dangling em
dash.

Dragged wider, the categories appear in full and the rule works exactly as §7 describes. The full
name and category are always in the row's `title`. Nothing was removed from the row to make space,
because the provider mark and the status dot belong to other features and taking one out is their
decision, not this one's.
