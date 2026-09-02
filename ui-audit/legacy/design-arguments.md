# Legacy — the design arguments

**These arguments are recorded because a future designer should know what the last system was
trying to prevent.**

Recording them is **not** a recommendation to keep any value. Every hex code, pixel count and
duration in this product is legacy and is being discarded. What is not disposable is the reasoning
beside them: each of these paragraphs was written after something went wrong, and a new palette will
meet the same failures unless it knows they happened.

The arguments below are extracted as prose, attributed to file and line, **with their values
deliberately left behind**. Where an argument records a past failure — a state that was invisible,
two things that rendered identically, a colour that meant two things at once — it is marked
**⚠ PAST FAILURE**.

---

## I. On spending colour

### ⚠ PAST FAILURE — the product spent all its colour on categories and none on interaction

`tokens.ts:71-85`

The palette had four accents for *what kind of thing something is* and **none at all for what you
are doing**. Selection, active tabs, links and focus were all carried by a three-percent lightness
shift, plus — on some rows — a small bar.

> Which meant **"which session am I in" was the hardest question the sidebar answered**, and a focus
> ring was a grey ring on a grey control. Spending colour on what a thing *is* and none on what you
> are *doing* is backwards for an app somebody drives with a keyboard.

The fix was one interaction accent with **four sanctioned uses and no fifth**: the active/selected
row or tab; sync and live iconography; links; focus rings.

> Never decorative. Never a category. **A badge on a non-interactive label is precisely what makes
> an accent unusable for selection later**, because the eye stops reading it as "this one".

### ⚠ PAST FAILURE — a colour that meant two things at once

`tokens.ts:120-152`

A caution state was needed for a deliberately-chosen mode. Both existing candidates were wrong, and
the analysis of *why* is the most reusable paragraph in the file:

> The `pending` colour means **in-flight** in this app, everywhere, and always moves. A static chip
> in that colour would be the first one in the product that does not mean "this is happening right
> now", and **one exception is all it takes to stop the colour answering that question.**
>
> The `error` colour means **something went wrong**. This is a supported mode a user chose on
> purpose, and **painting a valid setting as a failure teaches people to ignore the error colour.**

The count mattered to the decision: the in-flight meaning had **forty-eight call sites, a node glow
and a stream pulse** against the new meaning's two. So the established meaning kept the hue and the
newcomer took a free one.

> **it is never the only signal** — a word or a mark is required beside it.

### The categories are spaced against the statuses, not only against each other

`tokens.ts:38-45`

> `reviewed` is pushed to the cyan side so it cannot be read as `success`; `mcp` is pushed to the
> magenta side so it cannot be read as `danger`. `state` and `bespoke` are an indigo and a violet
> rather than two blues, because `warning` is now a blue — and **a badge a user could mistake for a
> status is a badge that has stopped saying what kind of thing this is.**

### Not red, on purpose

`tokens.ts:60-68`

On the accent for third-party tools nobody has reviewed:

> It is deliberately not red either — **MCP is not an error, and crying wolf on every external tool
> would teach people to stop looking.**

### ⚠ PAST FAILURE — two surfaces, two palettes, one accidental warning

`tokens.ts` (`SHARE_RAMP`)

Two surfaces drew provider shares and each had its own hardcoded palette, both landing within a few
degrees of the in-flight colour:

> So a workspace using one model **painted a full-width amber bar under the word SPEND**, which
> reads as a warning or as something in flight rather than as a proportion — on the one page built
> to be quiet.

The replacement is a neutral ramp, and the reasoning generalises:

> Share is **categorical, not semantic**: no segment means anything is wrong or anything is
> happening. Steps of neutral lightness keep adjacent segments apart inside one bar — which is all a
> share chart needs — and none of them can be mistaken for a state. **Every one of these surfaces
> names its series in a row beneath the bar, which is what lets the bar be quiet.**

### Density defeats saturation

`tokens.ts` (`STEP_TYPE`)

> The timeline is a dense column of these and **full-strength accents would turn it into a rainbow**,
> so each pair is a pale fill with a legible text colour rather than a bright one.

### One decision, not two that happen to look alike

`tokens.ts:47-50`

The graph's node accents and the plan card's category accents share their source, *"so the graph and
the plan card make one decision rather than two that happen to look alike."*

---

## II. On depth

### A shadow never appears without a hairline — and the rule survived an inversion with its reasoning reversed

`tokens.ts` (`ELEVATION`)

> Each level is a hairline **plus** a shadow, never a shadow alone, and the reason has flipped
> without the rule changing. On a near-black background a soft shadow was nearly invisible and the
> 1px edge catching light did the separating. On an off-white page **the shadow is the half that
> works and the hairline is the half that would otherwise read as a drawn rectangle**. Either alone
> still reads as a mistake; it is simply the other one carrying the weight now.

This is the clearest example in the codebase of a rule outliving the palette that produced it, and
it is the reason to read this file at all.

> depth should be something you notice only when it is missing: enough to say "this is on top",
> never enough to say "look at this shadow".

### ⚠ PAST FAILURE — a token whose name argued against what it drew

`tokens.ts` (`GLOW`)

The hover treatment was called **lift by light**, and on a near-black page the reasoning was sound:
a hovered card cannot get darker, only brighter. On an off-white page that is exactly backwards.

> The name is the only thing that had to change, and it changed because **a token called GLOW that
> draws a shadow is a token whose next reader will use it wrong.**

And the constraint that kept it neutral:

> hue is reserved for status and the interaction accent is reserved for interaction that MEANS
> something; **"you are hovering this" is neither** — it is the surface acknowledging a pointer.
> Shade without hue is the only way to say it that does not spend a colour.

### ⚠ PAST FAILURE — there was no stacking scale, so components picked z-indexes by eye

`tokens.ts` (`LAYER`)

> which is how an inbox row's overflow menu ended up **below** the two panel layers it opens over,
> while an agent card's menu sat **above** the full-screen code drawer.

The fix is six named steps and one rule:

> A number is chosen by asking **what kind of thing this is**, never by asking what it needs to beat
> today.

*(This audit found a menu that respects the scale and is still invisible, because a z-index cannot
escape a clipping ancestor. The scale is necessary and not sufficient.)*

### A rung the previous palette did not have

`tokens.ts` (`SURFACE.elevated`)

> Popovers used the card surface, one step up from the page, and on near-black that was enough: a
> shadow plus a hairline said "above". On a light page **a floating surface one percent off the card
> behind it reads as the same surface**, so a whole token is spent on it.

### ⚠ PAST FAILURE — disabled was expressed as opacity, and opacity compounds

`tokens.ts` (`TEXT.disabled`)

> The dark palette had three inks and expressed "unavailable" as 40% opacity on whatever the control
> already was, which on a near-black page is indistinguishable from a fourth grey. Naming the colour
> lets a disabled control say so in the palette's own terms rather than by being faded — and **a
> faded control inside a faded panel compounds, which is how a disabled row ends up less legible
> than the empty space beside it.**

---

## III. On size and rhythm

### ⚠ PAST FAILURE — nine radii, and a card rounder than the popover that opened out of it

`tokens.ts` (`RADIUS`)

> it had nine values spread across components that sit next to each other, **which is how a composer
> card ended up 6px rounder than the popover that opens out of it.**

The rule that replaced them is about **size, not component type**:

> a corner radius reads as a proportion of the box it turns, so the same value looks tight on a
> modal and bulbous on a small pill. Naming the steps after the size of thing they belong to is what
> keeps two people making the same choice.

And the exclusion:

> **A pill is not on this scale.** Something whose radius is half its height is a *shape*, not a
> corner treatment.

### ⚠ PAST FAILURE — seven font sizes that were not a ladder

`tokens.ts` (`TYPE`)

> the client had 11, 12, 13, 15, 12.5, 11.5 and 10 — **not a ladder but what happens when each
> component picks a size against whatever is next to it.**

### One weight on the ladder is deliberately claimed by no rung

`typeScale.ts:63-70`

The single most quotable decision in the type system:

> `bold` is on the ladder and **deliberately unused by every step above**. The specification calls
> 700 "rare; reserved for strong emphasis, not normal headings", and **a weight that no rung claims
> is the only way to keep that true: a heading reaching for 700 has to do it by hand, in a diff.**

The bundle enforces it — 700 is on the ladder and **off the font files**.

### The rung carries its own weight, so nobody gives a second opinion

`typeScale.ts` / `tokens.ts` (`TYPE`)

> the rungs carry their own weight now and these strings no longer name one. Writing a weight class
> beside a rung would be **a second opinion about a decision the ladder already made, and the two
> would drift the day the rung moved.**

### ⚠ PAST FAILURE — two thirds of the client was monospaced because strings looked technical

`typeScale.ts:117-128`

> the part people get wrong: **do not switch fonts merely because a string looks technical.** A
> slug, a version, a timestamp and a model name all LOOK like code and none of them is — they are
> metadata, they sit in sentences and in rows beside prose, and setting them in Mono is **what made
> two thirds of this client's text monospaced.**
>
> The test for Mono is not "does this look technical" but **"would fixed-width columns materially
> help somebody parse it".**

### The third family was removed on a principle, not a preference

`typeScale.ts:86-95`

A display serif carried the pre-session headings on the argument that those screens are *a page
rather than an instrument*. The specification answered it directly, and the serif went — *"the
bundle carries one fewer family."*

### Naming the relationship rather than the number

`tokens.ts` (`SPACE`)

> Naming the **relationship** (within a group vs. between sections) is what keeps the rhythm
> consistent when it's applied across five components by hand.

### An unnamed size in use twelve times is a rung whether or not the ladder admits it

`tokens.ts` (`ICON.badge`)

> Named because it was already in use — a bare `size={10}` at a dozen call sites — and **an unnamed
> size in use twelve times is a step of the ladder whether or not the ladder admits it.**

And why the icon ladder exists at all: the icon set is drawn on a 24px grid at stroke 2; scaled down
it *"reads heavy next to 12px text"*, hence a single reduced stroke weight for the whole product.

---

## IV. On motion

`tokens.ts` (`MOTION`)

> Two durations and one easing, because a transition that communicates a state change has to be
> perceptible and then out of the way. **Anything slower starts to feel like latency, which is the
> opposite of what a state change should say.**

---

## V. Arguments that are not about tokens, and are worth as much

These come from component and copy files rather than the token layer, and they encode the same kind
of hard-won knowledge.

### ⚠ PAST FAILURE — an affordance that appears after you commit to the action is not an affordance

`App.tsx:88-101`

The pane divider shows `cursor-col-resize` **at rest**, because the panel library only injects a
cursor once a drag is underway — so *"a divider you have not yet grabbed showed the ordinary arrow,
and the only way to find out it was draggable was to try."*

It is also **painted 1px and hit at 5px**: a 3px bar *"is three times wider than every border in the
system and therefore read as a drawn column rather than as the join between two surfaces — while
still being a small target to grab."*

And on the hover grip: *"A colour shift on a one-pixel line is not discoverable — you have to
already be looking at it to see it change."*

### ⚠ PAST FAILURE — a status word is correct and still useless

`lib/fleetSentence.ts:1-8`

> **"Get this wrong and the Cockpit is a status page."** … a strip of twenty cards each reading the
> same word. A status enum rendered as a label is what the hosting dashboard already gives, and it
> is the reason somebody is opening that instead of this. So the property this module has to hold is
> **not correctness — a status word is perfectly correct — it is specificity.** Every card must say
> something that is true of it and not of the twenty beside it.

### A stale figure beside a live one invites the reader to guess

`lib/fleetSentence.ts`

> the sentence is **replaced, not appended**. "Not connected" and nothing else. A card that says
> "not connected · 11 jobs today" **invites the reader to wonder which half is current.**

### ⚠ PAST FAILURE — an em dash with no explanation reads as a bug in the product

`lib/cockpitCopy.ts:305-308`

> **"Unknown is an em dash with a tooltip saying why."** An em dash with no explanation is a figure
> the reader assumes is a bug in the product rather than an absence in the record — and the two
> reasons a cost is unknown are genuinely different facts, so they are two sentences.

### Only one row in a list may be marked

`WorkList.tsx:96-111`

> **a list where a fifth of the rows are marked is a list nobody scans.** `waiting` earns it by
> being the only status where a PERSON is the blocker.

### Three empty states that must not collapse into one

`lib/cockpitCopy.ts:145-151`

> **Collapsing any two would tell an operator with forty jobs that nothing has been asked of their
> agents, because they had clicked "failed".**

### Grading confirmations, and what happens when you do not

`lib/cockpitCopy.ts:226-237`

> **Giving all three the same confirmation teaches people to click through all three.**

And: *"a dialog that does not name what it is about is one somebody confirms over the wrong card."*

### ⚠ PAST FAILURE — a bare letter that spent money from a screen it did not belong to

`lib/bareKeys.ts:8-15`

The most serious past failure recorded anywhere in this codebase:

> pressing `r` on the Threads board, with the composer, the run button and the trace panel all behind
> a full-screen view, **dispatched a real run of whichever agent was selected in the sidebar. Nothing
> on screen changed to say so.** On a workspace with a provider key that spends money, with no
> confirmation and no visible result — and `r` is a plausible keystroke on a board where somebody
> expects typing to reach a filter field.

And the meta-lesson, which is about how rules are kept rather than what they say:

> **A rule copied at five call sites is a rule the sixth listener is written without**, which is
> exactly how this happened.

### ⚠ PAST FAILURE — a keycap with no binding behind it

`CommandPalette.tsx:127-138`

> The palette draws this keycap, and the palette is reachable from everywhere. The only handler for
> it was mounted by one view — so on four screens out of five **the chord did nothing at all**, and
> on Windows it fell through to the browser and opened a new window. **A keycap with no binding
> behind it is decoration.**

And: *"a chord with two owners is a chord whose behaviour depends on which listener ran first."*

### An icon nobody can name is worse than a text button

`RightPanel.tsx:255-259`, `FleetStrip.tsx:143-146`

> The tooltip is not decoration here — **it is the label.**

And, on twenty identical controls in a strip: *"twenty identical 'More' buttons is twenty controls a
screen reader cannot tell apart"* — so each names its subject.

### ⚠ PAST FAILURE — a notice that described a mutation the socket had dropped

`useThreadKeys.ts:110-125`, `lib/socket.ts:1986`

> Written first, it claimed "Archived · discarded a pending diff (+42−11)" **over a socket that had
> silently dropped the command.**

The rule that came out of it: **a confirmation is a statement about what happened, not a prediction.**

### A component reused is a decision made once

`WorkGate.tsx:1-12`

> A second copy of this dialog would be the second confirmation the spec forbids, even though it
> looked identical: **two of them is two places for the version, the model or the public-URL warning
> to be wrong in, and the one that drifts is always the copy somebody made for the newer surface.**

### Two boards showing the same thing

`CockpitPointer.tsx:3-12`

> Pick one home … and give the other a pointer to it rather than a second card. **Two boards showing
> the same thing is how both stop being believed.**

### A confident number on the one surface whose argument is that its numbers are real

`WorkGate.tsx:27-32`

> Nothing can honestly predict the cost of a job whose graph has not run … **A confident figure here
> would be the one number on this surface that was made up**, on the tab whose whole argument is
> that its numbers are real.

### Hedging is not weakness when the record is genuinely silent

`lib/cockpitCopy.ts:110-115`

> `stopped_reporting` — both clauses, hedge intact. **It is the absence of an observation rather than
> an observation**, and rendering it as "failed" would be a confident claim about somebody's bill.

### A third state that is not the bad state

`FleetStrip.tsx:169-172`

> the probe's answer with its age, or nothing at all when nobody has asked — which is a third state
> and not "unhealthy". **A card reporting red because it had never been probed would be the product
> accusing a working agent.**

### Disabled-state discipline: state what is true rather than hide the control

`FullScreenView.tsx:14-16`

> a button that silently did nothing would be the one thing worse than one that explains itself.

---

## VI. The five sentences to hand a future designer first

1. **A weight that no rung claims is the only way to keep 700 rare** — a heading reaching for it has
   to do it by hand, in a diff.
2. **One exception is all it takes to stop a colour answering its question** — which is why the
   in-flight hue was not borrowed for caution.
3. **A shadow never appears without a hairline**, and the reason inverted with the palette while the
   rule did not.
4. **A status word is perfectly correct and still useless** — specificity, not correctness, is the
   property a fleet card has to hold.
5. **A rule copied at five call sites is a rule the sixth listener is written without** — which is
   how a bare letter came to spend money from a screen it did not belong to.
