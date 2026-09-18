// Turn `assets/agent_characters/` into the three pictures every agent wears, and into the typed
// module that names them.
//
// WHY THE DERIVED COPIES ARE COMMITTED RATHER THAN BUILT ON EVERY `npm run build`. The sources are
// 60MB of 1254px PNGs and 1672px-tall backgrounds; a sidebar row draws a 22px badge. Resizing at
// build time would mean an image dependency in `client/package.json` that exists to produce
// thirty-three files that never change, and a CI job that decodes 60MB of PNG to emit the same bytes
// it emitted last time. So this runs by hand when the source set changes, and `test:agent-faces` is
// what stops the output drifting from `lib/agentFaceFiles.ts` in between.
//
// ── THREE PICTURES, AND WHY THERE ARE THREE ───────────────────────────────────────────────────
//
// THE PRODUCT OWNER DREW TWO PORTRAITS PER AGENT, and the difference is not decoration. A
// `sidebar` source is a circular badge with a COLOURED RING around it; a `generic` source is the
// same character drawn as a free-standing line portrait with no ring and no circle. They were made
// for two different jobs and this generator keeps them apart:
//
//   THE BADGE GOES IN DENSE ROWS — the sidebar's agent list, the Cockpit work rows, the fleet strip,
//   the command palette. At 16 to 22px a borderless drawing is a smudge; the ring is what makes it
//   read as a distinct object at the size of a line of text, which is why the source carries its own
//   rather than having one drawn over it.
//
//   THE PORTRAIT GOES WHERE THERE IS ROOM FOR A FACE — the agent card at 44 and 56px, the detail
//   header at 96. Here the ring would be a frame round a frame: the card already mounts the picture
//   on a tile with a ring in the card's own surface colour, over the banner.
//
//   AND THE BANNER IS UNCHANGED, still cut from `agentN_bg`, which the new art did not replace.
//
// `AgentFace` PICKS BETWEEN THEM BY SIZE, and the threshold is stated there rather than here.
//
// ── WHAT THIS DOES THAT A RESIZE DOES NOT ─────────────────────────────────────────────────────
//
// THREE OF THE ELEVEN `generic` SOURCES CARRY A GREY CHECKERBOARD PAINTED INTO THEIR PIXELS, and
// two of the eleven `sidebar` ones have no alpha at all. Both are the same export slip — an editor's
// transparency indicator flattened into the image, or transparency dropped on the way out — and
// both are invisible until the picture lands on something that is not white. Shipped as they come,
// three cards would show a chequered tile and two sidebar rows a white square around the badge.
//
// SO THE BACKDROP IS NEUTRALISED AND THE BADGE IS CUT. The checkerboard is recognised by what it is
// — a NEUTRAL grey in a band well above the ink and well below the paper — and painted white, which
// is what the other eight sources already have behind them. An opaque badge has its circle measured
// and an alpha disc built for it, the same way `gen-empty-faces.mjs` does it one asset set over.
//
// AND THE PORTRAITS ARE NORMALISED TO THEIR OWN DRAWING. As delivered the art fills 68% of the
// frame on one source and 92% on another, which in a grid of cards reads as one agent photographed
// from further away. Each is cropped to its drawing's bounds and squared, so eleven cards carry
// eleven faces at one weight. The crop keeps the bottom flush where the source cut the body off at
// its own edge, because a torso cropped mid-tile floats and a torso cropped at the tile's edge
// reads as continuing past it.
//
// ── THE BANNER ────────────────────────────────────────────────────────────────────────────────
//
// THE BACKGROUNDS ARE PORTRAIT (941×1672) AND A BANNER IS A WIDE BAND. Serving the whole thing and
// letting `background-size: cover` crop it would push 2.8MB down the wire to show a 320×80 slice of
// it, so the band is cut here: the centre 2:1 crop, resized to 800×400. 2:1 rather than the 4:1 the
// banner actually draws, because `cover` should have something to work with when the card is wider
// than it is today and when the agent detail header draws the same picture at a different shape.
//
// AND IT IS BLURRED FIRST, WHICH IS NOT A STYLE CHOICE. The sources are printed through a HALFTONE
// SCREEN — a regular grid of dots about six pixels apart — and the delivered band is 800px wide
// against a 941px source, so the resize barely resamples and every dot survives it. A regular grid
// of dots drawn at a scale the browser then scales again is the textbook recipe for moiré, and on
// screen it does not read as texture: it reads as a banner that shimmers when the grid scrolls.
//
// A GAUSSIAN AT FIVE PIXELS, MEASURED RATHER THAN GUESSED. The dot pitch is the thing being removed,
// so the radius is set against it: three still leaves a visible grid and five closes it completely
// while keeping every brushstroke the artwork actually has. It is applied BEFORE the resize, at the
// source's own resolution, which is the only place the pitch is known — and it costs nothing to
// deliver, because a smooth field is also a far smaller JPEG than a dithered one.
//
//   node scripts/gen-agent-faces.mjs        # needs Pillow: python3 -m pip install Pillow
//
// The image work itself is Python's, because that is what is on this machine and because a Node
// image library would be a dependency in the client's package.json for a script the client never
// runs.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, "..");
const SOURCES = join(CLIENT, "..", "assets", "agent_characters");
const OUT = join(CLIENT, "public", "agent-faces");

/** How many agents there are. A source set of a different size is a mistake rather than a resize. */
const COUNT = 11;
/** The portrait, square. 256 is 2× the largest size anything draws it at — the detail header's 96. */
const PORTRAIT = 256;
/**
 * The badge, square.
 *
 * FOUR TIMES ITS LARGEST USE, which is the sidebar's 22px, and eight times the 16px rows. That is
 * more headroom than the portrait gets on purpose: a badge is a thin coloured ring around a small
 * drawing, and a ring landing between two device pixels goes grey down one side. The file is a few
 * kilobytes either way.
 */
const BADGE = 128;
/** The banner band, 2:1. See the header for why it is wider than the band a card draws. */
const BANNER = [800, 400];
const QUALITY = 82;

mkdirSync(OUT, { recursive: true });

const script = `
import os, sys
from PIL import Image, ImageChops, ImageDraw, ImageFilter

src, dst, count, portrait, badge, bw, bh, quality = (
    sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]),
    int(sys.argv[5]), int(sys.argv[6]), int(sys.argv[7]), int(sys.argv[8]),
)

# THE CHECKERBOARD'S BAND. Its two tones measure about 135 and 198 and both are NEUTRAL — red, green
# and blue within a couple of units of each other. The ink it must not touch is below 60 and the
# paper above 250, so a band from 110 to 230 sits in open space on both sides. Antialiasing along a
# black line does pass through it, but only as single pixels with black on one side, and a 1254px
# source delivered at 256 buries them five to one.
CHECK_LO, CHECK_HI, NEUTRAL = 110, 230, 15
# WHAT COUNTS AS THE DRAWING WHEN THE CROP IS MEASURED, and the number is the fix for faces coming
# out at different sizes on the cards.
#
# FOUR OF THE ELEVEN ARE SET ON A PALE DISC — agent1, 2, 4 and 9 — and the disc is WIDER than the
# figure on it. Measured at 250 the disc is "drawing", so those four were cropped to a circle with a
# small person inside it while the other seven were cropped to the person: agent-01 ended up with
# 183px of figure in a 256px tile against agent-03's 235, and in a grid that reads as one agent
# photographed from further away.
#
# 200 IS BELOW THE INK AND ABOVE THE DISC, which measures about 245. The line art is solid black and
# its antialiasing is the only thing in between, so this is not a threshold anything lands on by
# accident. The disc is not REMOVED, only ignored while the crop is measured — and what survives of
# it is invisible anyway, nine units off the white it sits on.
PAPER = 200
# How the portrait's square is sized against the head it holds — see square. The band is the top
# third, where only hair and skull live; 1.9 heads across leaves the shoulders room without letting
# a drawing that has more of them shrink the face; the air is what sits above the hair.
HEAD_BAND, HEAD_RATIO, HEAD_AIR = 0.34, 1.9, 0.06
# Alpha at or above this is the badge; below it is the space around it.
OPAQUE = 200
# The disc is drawn at this multiple and brought down, which is what antialiases a cut rim.
SS = 4
# Source pixels off a measured radius, for the row where the rim's antialiasing is mixed with
# whatever was behind it.
INSET = 2
# The banner's blur, in source pixels, against a halftone pitch of about six. See the header: this is
# a moiré fix rather than a soft-focus effect, and the radius is set by the dot grid it removes.
SCREEN = 5

def source(stem):
    """The source file for a stem, whichever extension it came with."""
    for ext in ('.png', '.jpeg', '.jpg', '.webp'):
        path = os.path.join(src, stem + ext)
        if os.path.exists(path):
            return path
    raise SystemExit('no source image for ' + stem)

def square(im, mask, box, fill):
    """
    Crop to a square sized against the HEAD, so eleven cards carry eleven faces at one size.

    CROPPING TO THE WHOLE DRAWING WAS THE OBVIOUS THING AND IT DOES NOT WORK. These eleven are not
    framed alike: two are a head and a collar, one is a head with a raised arm beside it, one has a
    braid running to the waist. Normalise the FIGURE and every drawing fills its tile — which is
    exactly why the faces then differ by half again, because a tile filled by a head is a big face
    and a tile filled by a head plus an arm is a small one. Measured on the output: 157px of head
    against 232px, in the same 256px box.

    SO THE HEAD IS THE THING HELD CONSTANT. It is measured as the widest run of ink in the top third
    of the drawing, which on every one of these is hair and skull and nothing else — shoulders,
    arms and braids all begin lower. The square is 1.9 heads across, which leaves room for the
    shoulders these drawings have without letting the ones that have more of them shrink the face.

    CENTRED ON THE HEAD RATHER THAN ON THE DRAWING, for the same reason: a raised arm pulls the
    drawing's centre sideways and would set the face off-axis in its tile.

    PADDED, NOT CLIPPED. The square is allowed to run off the source — it usually does at the top,
    because the head starts near the frame's edge — so only the part that exists is copied, onto
    paper, at the offset it belongs at. Cropping out of bounds and pasting the result would put a
    black band wherever the source ran out.
    """
    x0, y0, x1, y1 = box
    px = mask.load()
    head, hy = 0, y0
    for y in range(y0, y0 + max(1, int((y1 - y0) * HEAD_BAND))):
        xs = [x for x in range(x0, x1) if px[x, y]]
        if xs and xs[-1] - xs[0] > head:
            head, hy = xs[-1] - xs[0], y
    if head <= 0:
        head, hy = x1 - x0, y0
    side = max(1, int(head * HEAD_RATIO))
    xs = [x for x in range(x0, x1) if px[x, hy]]
    cx = (xs[0] + xs[-1]) // 2 if xs else (x0 + x1) // 2
    left, top = cx - side // 2, y0 - int(side * HEAD_AIR)
    w, h = im.size
    cl, ct, cr, cb = max(0, left), max(0, top), min(w, left + side), min(h, top + side)
    out = Image.new(im.mode, (side, side), fill)
    if cr > cl and cb > ct:
        out.paste(im.crop((cl, ct, cr, cb)), (cl - left, ct - top))
    return out

for n in range(1, count + 1):
    # --- the badge: the ringed circle, transparent around it ------------------------------------
    im = Image.open(source('agent%dsidebar' % n)).convert('RGBA')
    lo, _ = im.getchannel('A').getextrema()
    if lo >= OPAQUE:
        # NO ALPHA AT ALL, so the circle has to be found. Its rim is a saturated colour against
        # paper, which is the one thing on the image far from every colour its own border carries —
        # gen-empty-faces.mjs argues this at length for the same reason.
        rgb = im.convert('RGB')
        px = rgb.load()
        w, h = rgb.size
        edge = set()
        for y in list(range(6)) + list(range(h - 6, h)):
            for x in range(0, w, 3):
                r, g, b = px[x, y]
                edge.add((r // 16 * 16 + 8, g // 16 * 16 + 8, b // 16 * 16 + 8))
        for x in list(range(6)) + list(range(w - 6, w)):
            for y in range(0, h, 3):
                r, g, b = px[x, y]
                edge.add((r // 16 * 16 + 8, g // 16 * 16 + 8, b // 16 * 16 + 8))
        x0, y0, x1, y1 = w, h, -1, -1
        for y in range(h):
            for x in range(w):
                r, g, b = px[x, y]
                if all(abs(r - q[0]) + abs(g - q[1]) + abs(b - q[2]) >= 120 for q in edge):
                    if x < x0: x0 = x
                    if x > x1: x1 = x
                    if y < y0: y0 = y
                    if y > y1: y1 = y
        if x1 < 0:
            raise SystemExit('agent%dsidebar: no rim found' % n)
        cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
        radius = max(x1 - x0, y1 - y0) / 2.0 - INSET
        mask = Image.new('L', (w * SS, h * SS), 0)
        ImageDraw.Draw(mask).ellipse(
            [(cx - radius) * SS, (cy - radius) * SS, (cx + radius) * SS, (cy + radius) * SS], fill=255)
        im.putalpha(mask.resize((w, h), Image.LANCZOS))
        print('  agent%02d badge: cut a circle, r=%d' % (n, radius))

    # THE BADGE IS ALREADY A CIRCLE, so it is squared on its own bounds and nothing is measured: its
    # rim is the frame, and every one of the eleven fills it the same way by construction.
    x0, y0, x1, y1 = im.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
    side = max(x1 - x0, y1 - y0)
    disc = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    disc.paste(im.crop((x0, y0, x1, y1)), ((side - (x1 - x0)) // 2, (side - (y1 - y0)) // 2))
    disc.resize((badge, badge), Image.LANCZOS).save(
        os.path.join(dst, 'agent-%02d-sidebar.png' % n), 'PNG', optimize=True)

    # --- the portrait: the drawing on its own paper, normalised ---------------------------------
    im = Image.open(source('agent%dgeneric' % n)).convert('RGB')
    w, h = im.size
    px = im.load()
    # IS THERE A CHECKERBOARD? Asked of the border, which is paper on every one of these by
    # construction — the drawing never reaches the frame's outermost rows.
    edge = [px[x, y] for y in (1, h - 2) for x in range(0, w, 7)]
    edge += [px[x, y] for x in (1, w - 2) for y in range(0, h, 7)]
    checks = sum(1 for r, g, b in edge
                 if max(r, g, b) - min(r, g, b) < NEUTRAL and CHECK_LO < (r + g + b) / 3 < CHECK_HI)
    if checks > len(edge) // 100:
        for y in range(h):
            for x in range(w):
                r, g, b = px[x, y]
                if max(r, g, b) - min(r, g, b) < NEUTRAL and CHECK_LO < (r + g + b) / 3 < CHECK_HI:
                    px[x, y] = (255, 255, 255)
        print('  agent%02d portrait: painted out a checkerboard' % n)

    m = im.convert('L').point(lambda v: 255 if v < PAPER else 0)
    box = m.getbbox()
    if box is None:
        raise SystemExit('agent%dgeneric: the whole frame is paper' % n)
    square(im, m, box, (255, 255, 255)).resize((portrait, portrait), Image.LANCZOS).save(
        os.path.join(dst, 'agent-%02d.png' % n), 'PNG', optimize=True)

    # --- the banner: the centre 2:1 band, unchanged ----------------------------------------------
    bg = Image.open(source('agent%d_bg' % n)).convert('RGB')
    w, h = bg.size
    band = min(h, int(w / 2))
    top = (h - band) // 2
    bg.crop((0, top, w, top + band)).filter(
        ImageFilter.GaussianBlur(SCREEN)).resize((bw, bh), Image.LANCZOS).save(
        os.path.join(dst, 'agent-%02d-bg.jpg' % n), 'JPEG',
        quality=quality, optimize=True, progressive=True)

print('wrote %d badges, %d portraits and %d banners' % (count, count, count))
`;

execFileSync(
  "python3",
  ["-c", script, SOURCES, OUT, String(COUNT), String(PORTRAIT), String(BADGE),
    String(BANNER[0]), String(BANNER[1]), String(QUALITY)],
  { stdio: "inherit" },
);

const entries = Array.from({ length: COUNT }, (_, i) => {
  const id = `agent-${String(i + 1).padStart(2, "0")}`;
  return `  { id: "${id}", portrait: "${id}.png", sidebar: "${id}-sidebar.png", banner: "${id}-bg.jpg" },`;
}).join("\n");

writeFileSync(
  join(CLIENT, "src", "lib", "agentFaceFiles.ts"),
  `// GENERATED by scripts/gen-agent-faces.mjs. Do not edit by hand.
//
// The eleven portrait/badge/banner sets in \`public/agent-faces/\`, in source order, as a typed list.
// The list is built at BUILD TIME rather than read from a directory at runtime for the reason
// \`agentArtFiles.ts\` gives one asset set over: a browser cannot list a directory, and a server that
// could would be answering a question whose answer must be identical on every replica.
//
// THE ORDER IS THE MAPPING. An agent takes the entry at its own position in its workspace's
// creation order, so a list in a different order hands every agent in the workspace a different
// face. The ids are zero-padded precisely so that "source order" and "sorted order" are the same
// sequence on every platform — directory iteration order is not stable across them, and this
// project has already been bitten once by a platform-dependent path.
//
// \`test:agent-faces\` asserts this matches what is actually in \`public/agent-faces\`.

export interface AgentFaceFiles {
  /** The value \`agents.picture\` stores. */
  readonly id: string;
  /**
   * The free-standing portrait, for surfaces with room for a face — the agent card and the detail
   * header. No ring: the card mounts it on a tile that draws its own.
   */
  readonly portrait: string;
  /**
   * The circular badge with its own coloured ring, for dense rows — the sidebar, the Cockpit work
   * rows, the fleet strip, the command palette. Transparent around the ring.
   */
  readonly sidebar: string;
  /** The banner band, 2:1, in the hue this agent's background was painted in. */
  readonly banner: string;
}

export const AGENT_FACE_FILES: readonly AgentFaceFiles[] = [
${entries}
];
`,
);

console.log(`wrote ${COUNT} sets to public/agent-faces and src/lib/agentFaceFiles.ts`);
