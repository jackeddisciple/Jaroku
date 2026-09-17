// Turn `assets/agent_characters/` into the two pictures every agent card serves, and into the typed
// module that names them.
//
// WHY THE DERIVED COPIES ARE COMMITTED RATHER THAN BUILT ON EVERY `npm run build`. The sources are
// 40MB of 1254px PNGs and 1672px-tall backgrounds; a card draws a 56px portrait over an 80px band.
// Resizing at build time would mean an image dependency in `client/package.json` that exists to
// produce twenty-two files that never change, and a CI job that decodes 40MB of PNG to emit the same
// bytes it emitted last time. So this runs by hand when the source set changes, and
// `test:agent-faces` is what stops the output drifting from `lib/agentFaceFiles.ts` in between.
//
// This is `gen-agent-art.mjs`'s arrangement exactly, one asset set over, and it is deliberately the
// same one: two generators in a client with two derived image sets should not be two different
// shapes of script.
//
// ── THE ONE THING THIS DOES THAT A RESIZE DOES NOT ─────────────────────────────────────────────
//
// THE PORTRAIT IS A CIRCLE ON A WHITE SQUARE, AND THE CARD DRAWS A ROUNDED SQUARE. Cropped as it
// comes, the four corners are white — and white is not a colour this palette has at card level, so
// on a #FAFAF9 sheet they read as four chipped corners rather than as a picture. A circular mask in
// CSS is not the fix (the design wants the squircle) and neither is a transparent PNG (the corners
// would then show the banner through them, which is worse). What fills them is the character's own
// backdrop, CONTINUED outward to the square's edge.
//
// AND IT IS CONTINUED RATHER THAN FLOODED, WHICH IS THE WHOLE OF WHY THIS IS THIRTY LINES INSTEAD
// OF THREE. Two versions were written before this one and each failed in a way worth recording,
// because both are the obvious thing to try:
//
//   FLOOD THE CORNERS WITH THE BACKDROP COLOUR. There is no such colour. Every one of the eleven
//   circles is drawn on a GRADIENT, so one hex meets it along an arc and the seam reads as a circle
//   faintly outlined on the card. Measuring harder does not help.
//
//   EXTEND EVERY EDGE PIXEL OUTWARD ALONG ITS OWN RAY. This continues the gradient perfectly and
//   also continues the CHARACTER: hair that touches the circle's edge is dragged into the corner as
//   a dark bar, and three of the eleven grew a pair of antennae.
//
// So the ring just inside the circle's edge is sampled BY ANGLE and then filtered down to the
// backdrop alone — a sample too far from the ring's median is hair, a collar or a raised hand, and
// is replaced by interpolating across it from the backdrop either side. That field fills the square,
// and the artwork is laid back over it.
//
// WHICH LEAVES THE ARTWORK CLIPPED BY A CIRCLE 4% INSIDE ITS OWN, AND THAT IS THE POINT RATHER THAN
// A COMPROMISE. The source is drawn to be cut off by its circle — shoulders and hair run into the
// edge deliberately — so cutting at 0.96 is the same picture, and what changes is only that the cut
// now happens against the character's own backdrop instead of against white. Where the backdrop
// meets the corners there is no edge to see; where the character meets it, the edge you see is the
// character's own silhouette, which is what §04 means by "artwork may have its own silhouette".
//
// THE RING IS READ INSIDE THE EDGE AND THE ARTWORK IS CLIPPED INSIDE IT TOO, which is what deals
// with the antialiased fringe: the source's circle is drawn against white, so its outermost pixels
// are part backdrop and part white and belong to neither. Reading at 0.94 of the radius and clipping
// at 0.96 drops the fringe entirely.
//
// ── THE BANNER ────────────────────────────────────────────────────────────────────────────────
//
// THE BACKGROUNDS ARE PORTRAIT (941×1672) AND A BANNER IS A WIDE BAND. Serving the whole thing and
// letting `background-size: cover` crop it would push 2.8MB down the wire to show a 320×80 slice of
// it, so the band is cut here: the centre 2:1 crop, resized to 800×400. 2:1 rather than the 4:1 the
// banner actually draws, because `cover` should have something to work with when the card is wider
// than it is today and when the agent detail header draws the same picture at a different shape.
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

/** How many pairs there are. A source set of a different size is a mistake rather than a resize. */
const COUNT = 11;
/** The portrait, square. 256 is 2× the largest size anything draws it at — the detail header's 96. */
const PORTRAIT = 256;
/** The banner band, 2:1. See the header for why it is wider than the band a card draws. */
const BANNER = [800, 400];
const QUALITY = 82;

mkdirSync(OUT, { recursive: true });

const script = `
import math, os, sys
from PIL import Image, ImageDraw

src, dst, count, portrait, bw, bh, quality = (
    sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]),
    int(sys.argv[5]), int(sys.argv[6]), int(sys.argv[7]),
)

# THE SQUARE IS BUILT AT TWICE THE DELIVERED SIZE and downsampled at the end. The fill below walks
# pixels in Python, so the working size is what decides whether this runs in a second or a minute —
# and doing it here rather than at 1254px costs nothing visible, because every pixel it writes is a
# copy of one a few pixels away.
WORK = portrait * 2
# How many directions the backdrop ring is sampled in. At WORK=512 the circle's circumference is
# about 1600px, so 1440 spokes is a shade under one per pixel — fine enough that two neighbouring
# pixels never land more than one sample apart, which is what keeps the corners smooth.
SPOKES = 1440
# Read the ring here, clip the artwork here. See the header: between the two lies the antialiased
# edge, which belongs to neither the backdrop nor the white around it.
READ, CLIP = 0.94, 0.96
# How far from the ring's median a sample may be and still count as backdrop. The eleven backdrops
# span about 35 units of RGB distance across their own gradients; hair and clothing come in at four
# to five times that, so anywhere in between separates them and 70 is in the middle of it.
BACKDROP = 70
# A moving average over ±3° at the end, which is not doing the separating — it is smoothing the joins
# where an interpolated run meets a measured one, so a wide collar cannot leave a corner with a
# visible crease in it.
SMOOTH = 12

def source(stem):
    """The source file for a stem, whichever extension it came with."""
    for ext in ('.png', '.jpeg', '.jpg', '.webp'):
        path = os.path.join(src, stem + ext)
        if os.path.exists(path):
            return path
    raise SystemExit('no source image for ' + stem)

def circle(im):
    """The drawn circle's centre and radius, from the bounding box of what is not white."""
    grey = im.convert('L')
    # 250 rather than 255: the source's white is white, and a JPEG-ish source's would not be.
    box = grey.point(lambda v: 255 if v < 250 else 0).getbbox()
    if box is None:
        raise SystemExit('a portrait that is entirely white')
    left, top, right, bottom = box
    return ((left + right) / 2, (top + bottom) / 2, min(right - left, bottom - top) / 2)

def backdrop_ring(px, size, half, c):
    """The backdrop's colour by angle, with the character interpolated out of it."""
    ring = []
    for i in range(SPOKES):
        a = i * 2 * math.pi / SPOKES
        x = min(size[0] - 1, max(0, int(round(c + half * READ * math.cos(a)))))
        y = min(size[1] - 1, max(0, int(round(c + half * READ * math.sin(a)))))
        ring.append(px[x, y])

    # THE MEDIAN PER CHANNEL, which is a robust enough centre for this: whatever share of the ring
    # the character occupies, it is well under half in all eleven, so the median lands in the
    # backdrop rather than between the two.
    mid = tuple(sorted(s[ch] for s in ring)[SPOKES // 2] for ch in (0, 1, 2))
    keep = [
        sum((s[ch] - mid[ch]) ** 2 for ch in (0, 1, 2)) <= BACKDROP ** 2
        for s in ring
    ]
    if not any(keep):
        # A circle whose backdrop is a minority of its own edge. None of the eleven is, and a
        # generator that silently produced something else would be worse than one that stops.
        raise SystemExit('no backdrop found around the circle')

    # INTERPOLATED ACROSS EACH RUN OF THE CHARACTER, circularly, so a run that straddles due east is
    # not two runs. Walking out to the nearest kept sample each side and mixing by how far along the
    # run a spoke sits continues the gradient THROUGH the character rather than flattening it.
    out = list(ring)
    for i in range(SPOKES):
        if keep[i]:
            continue
        lo = next(i - k for k in range(1, SPOKES + 1) if keep[(i - k) % SPOKES])
        hi = next(i + k for k in range(1, SPOKES + 1) if keep[(i + k) % SPOKES])
        t = (i - lo) / (hi - lo)
        a, b = ring[lo % SPOKES], ring[hi % SPOKES]
        out[i] = tuple(int(round(a[ch] + (b[ch] - a[ch]) * t)) for ch in (0, 1, 2))

    return [
        tuple(
            int(round(sum(out[(i + k) % SPOKES][ch] for k in range(-SMOOTH, SMOOTH + 1)) / (2 * SMOOTH + 1)))
            for ch in (0, 1, 2)
        )
        for i in range(SPOKES)
    ]


def squared(im):
    """The circle on a square of its own backdrop: no white corners, no fringe, no streaks."""
    half = im.size[0] / 2
    c = half - 0.5
    ring = backdrop_ring(im.load(), im.size, half, c)

    # THE FIELD IS ANGULAR AND HAS NO RADIAL TERM, and the singularity that implies at the centre
    # does not matter: the artwork covers everything inside CLIP and only the corners are ever
    # seen. What the corners need is smoothness with their neighbours, which an angular field has.
    out = Image.new('RGB', im.size)
    field = out.load()
    for y in range(im.size[1]):
        dy = y - c
        for x in range(im.size[0]):
            field[x, y] = ring[int(math.atan2(dy, x - c) * SPOKES / (2 * math.pi)) % SPOKES]

    mask = Image.new('L', im.size, 0)
    inset = half * (1 - CLIP)
    ImageDraw.Draw(mask).ellipse(
        (inset, inset, im.size[0] - 1 - inset, im.size[1] - 1 - inset), fill=255)
    out.paste(im, (0, 0), mask)
    return out

for n in range(1, count + 1):
    # --- the portrait: the circle bled out to a full-bleed square ------------------------------
    im = Image.open(source('avatar%d' % n)).convert('RGB')
    cx, cy, r = circle(im)
    # CROPPED TO THE CIRCLE'S OWN BOUNDS, not to the source's square: the white margin around the
    # circle is uneven, and cropping to the circle is what centres the face in the card's box.
    side = int(r * 2)
    square = im.crop((int(cx - r), int(cy - r), int(cx - r) + side, int(cy - r) + side))
    squared(square.resize((WORK, WORK), Image.LANCZOS)).resize(
        (portrait, portrait), Image.LANCZOS).save(
        os.path.join(dst, 'avatar-%02d.png' % n), 'PNG', optimize=True)

    # --- the banner: the centre 2:1 band ------------------------------------------------------
    bg = Image.open(source('avatar%d_bg' % n)).convert('RGB')
    w, h = bg.size
    band = min(h, int(w / 2))
    top = (h - band) // 2
    bg.crop((0, top, w, top + band)).resize((bw, bh), Image.LANCZOS).save(
        os.path.join(dst, 'avatar-%02d-bg.jpg' % n), 'JPEG',
        quality=quality, optimize=True, progressive=True)

print('wrote %d portraits and %d banners' % (count, count))
`;

execFileSync(
  "python3",
  ["-c", script, SOURCES, OUT, String(COUNT), String(PORTRAIT), String(BANNER[0]), String(BANNER[1]), String(QUALITY)],
  { stdio: "inherit" },
);

const entries = Array.from({ length: COUNT }, (_, i) => {
  const id = `avatar-${String(i + 1).padStart(2, "0")}`;
  return `  { id: "${id}", portrait: "${id}.png", banner: "${id}-bg.jpg" },`;
}).join("\n");

writeFileSync(
  join(CLIENT, "src", "lib", "agentFaceFiles.ts"),
  `// GENERATED by scripts/gen-agent-faces.mjs. Do not edit by hand.
//
// The eleven portrait/banner pairs in \`public/agent-faces/\`, in source order, as a typed list. The
// list is built at BUILD TIME rather than read from a directory at runtime for the reason
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
  /** The square portrait, drawn on the character's own hue and full bleed to its edges. */
  readonly portrait: string;
  /** The banner band, 2:1, in the same hue as the portrait it belongs to. */
  readonly banner: string;
}

export const AGENT_FACE_FILES: readonly AgentFaceFiles[] = [
${entries}
];
`,
);

console.log(`wrote ${COUNT} pairs to public/agent-faces and src/lib/agentFaceFiles.ts`);
