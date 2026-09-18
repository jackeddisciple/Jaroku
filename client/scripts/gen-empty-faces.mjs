// Turn `assets/emptychar_illustrations/` into the six badges the new-agent screen wears above its
// greeting, and into the typed module that names them.
//
// This is `gen-agent-faces.mjs`'s arrangement exactly, one asset set over, and deliberately so: a
// client with three derived image sets should not have three different shapes of script. Same
// reasons for committing the output rather than building it — 7MB of 1254px PNGs to produce six
// files that never change — and `test:empty-faces` is what stops the output drifting from
// `lib/emptyFaceFiles.ts` in between.
//
// ── THE ONE THING THIS DOES THAT A RESIZE DOES NOT ─────────────────────────────────────────────
//
// FOUR OF THE SIX SOURCES ARE NOT TRANSPARENT, AND THREE OF THEM LOOK AS THOUGH THEY ARE. img1,
// img4 and img5 carry a GREY CHECKERBOARD PAINTED INTO THEIR PIXELS — someone exported "PNG with
// transparency" and the editor's transparency indicator got flattened in with the artwork — and
// img3 sits on a solid black square. Only img2 and img6 have real alpha. Composited over the page
// as they come, three badges would arrive inside grey chequered tiles and one inside a black box.
//
// SO THE DISC IS CUT OUT HERE. Every source is one circle centred on a square, which is the whole
// reason this can be done by geometry rather than by an alpha matte: find the circle, keep what is
// inside it, drop everything else.
//
// FOUND BY SCANNING RAYS INWARD FROM THE EDGE, and a FLOOD FILL WAS TRIED FIRST AND IS WRONG. The
// fill is the obvious tool — the backdrop touches a corner and a circle inscribed in its own square
// never does — and it failed in both directions at once, which is worth recording because it looked
// like the right answer until the output was composited over magenta:
//
//   IT WALKED STRAIGHT THROUGH img3's GREEN RING. A fill spreads wherever a pixel is close enough
//   to its NEIGHBOUR, and the ring is antialiased against the black behind it — thirty or so
//   intermediate pixels, each within a few units of the last. Green against black is a difference
//   of three hundred and the fill never has to make that step; it takes thirty small ones instead,
//   eats the ring, and stops on the off-white interior. Raising the tolerance makes this worse and
//   lowering it stops the fill crossing the checkerboard's own join.
//
//   AND IT BARELY ENTERED THE CHECKERBOARDS, leaving a bounding box the size of the whole image on
//   three of the six — so the radius came out fifty pixels wide of the circle and each of those
//   badges kept a grey collar of leftover backdrop outside its rim.
//
// SO NOTHING IS TRACED. For each of 720 angles a ray walks from the image edge TOWARDS the centre
// and stops at the first pixel that is not backdrop, which is that ray's outer boundary. Walking
// outside-in is the whole trick: the backdrop test has to be true where the backdrop is and is
// never asked about the artwork, so what the interior is made of cannot mislead it — and there is
// no connectivity, so no gradient can be walked across in small steps. The centre falls out of
// opposite pairs of rays and the radius is the MEDIAN of the 720, which a stray speck of dust in
// one corner cannot move.
//
// THE BACKDROP IS READ OFF EACH IMAGE'S OWN BORDER rather than assumed. A six-pixel frame around
// the edge is backdrop by construction whatever the source turned out to be — two greys, solid
// black, or nothing at all — so the same code handles all three without being told which is which.
//
// AND THE EDGE IS DRAWN AS A CIRCLE RATHER THAN TRACED. Measured per ray it is ragged at the
// sub-pixel level, and a badge with a faintly lumpy rim reads as a badly cut sticker. The rays
// decide WHERE the circle is; the alpha is then a clean antialiased disc at that radius.
//
// EVERYTHING INSIDE THE CIRCLE IS KEPT, RING AND ALL — the product owner's words twice over, and
// the reason this takes two pixels off the radius where its sibling takes four percent. That script
// is cutting a character out of a backdrop it then continues outward, so it has a wide fringe of
// half-backdrop half-white pixels to drop. These sources are RINGED: the coloured stroke around the
// rim is the drawing's own outline, about ten source pixels thick, and four percent of a 570px
// radius is twenty-three — it would shave the ring off entirely.
//
// SO THE INSET IS ABSOLUTE RATHER THAN PROPORTIONAL, which is the whole point of writing it as a
// count of pixels. What has to come off is exactly the row where the ring's antialiasing is mixed
// with the checkerboard or the black behind it, and that row is one or two pixels wide whatever the
// circle's radius happens to be. A percentage would mean the amount of ring removed depended on how
// big the source was, which is not a relationship anything here wants.
//
//   node scripts/gen-empty-faces.mjs        # needs Pillow: python3 -m pip install Pillow
//
// The image work is Python's, for the reason the sibling gives: a Node image library would be a
// dependency in the client's package.json for a script the client never runs.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, "..");
const SOURCES = join(CLIENT, "..", "assets", "emptychar_illustrations");
const OUT = join(CLIENT, "public", "empty-faces");

/** How many badges there are. A source set of a different size is a mistake rather than a resize. */
const COUNT = 6;
/**
 * The badge, square, in delivered pixels.
 *
 * FOUR TIMES WHAT IT DRAWS AT, which `EmptyFaceRow` sets at 44 — the product owner's call between
 * the 32px logo this replaces and the 56px that would have outshouted the question under it.
 *
 * FOUR TIMES RATHER THAN TWO because these are line drawings with a thin coloured rim, which is the
 * worst case for a downscale: at 2× a 3× display still resamples, and a rim landing between two
 * device pixels goes grey down one side of the badge and not the other. 176 is exact at 1×, 2× and
 * 4×, and six of them come to about 300KB — paid once, cached, and never requested again.
 */
const BADGE = 176;

mkdirSync(OUT, { recursive: true });

const script = `
import sys
from PIL import Image, ImageChops, ImageDraw

src, dst, count, badge = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])

# How far from EVERY colour on the image's border a pixel must sit, summed over RGB, to count as
# part of the drawing. Deliberately generous: this is not trying to find the rim's outermost
# antialiased pixel, it is trying to find the rim's SOLID body, and the numbers are nowhere near
# each other. Measured along a centre row: img1's rim is (0,91,254) against greys of 136 and 199,
# which is 307 away from the nearer one; img4's is (249,46,46), 456 away; img3's is (15,195,47)
# against black, 257 away. The blend between the two checkerboard greys peaks about 36 from one of
# them. 120 sits in the middle of a gap that is never narrower than 200.
SOLID = 120
# Alpha at or above this is the drawing, for the two sources that really are transparent.
OPAQUE = 200
# Source pixels added back to the measured radius, for the rim's own antialiased edge. The trace
# shows exactly two: on img1 the rim is solid at x=39, half-mixed at 38 and nearly all backdrop at
# 37. One is added rather than two, so the row that is mostly checkerboard stays out.
BLEND = 1
# The disc is drawn at this multiple and downsampled, which is what antialiases the rim. Drawing it
# at final size and smoothing afterwards softens the artwork as well as the edge.
SS = 4
# How wide a frame counts as "the border". Every source is a circle inscribed in its square, so a
# frame this thin is backdrop by construction whatever the backdrop turned out to be.
FRAME = 6


def border_colours(im):
    """The colours on the outer frame, quantised. See the header: read, never assumed."""
    w, h = im.size
    px = im.load()
    seen = set()
    for y in list(range(FRAME)) + list(range(h - FRAME, h)):
        for x in range(0, w, 3):
            r, g, b, a = px[x, y]
            if a >= OPAQUE:
                seen.add((r // 16 * 16 + 8, g // 16 * 16 + 8, b // 16 * 16 + 8))
    for x in list(range(FRAME)) + list(range(w - FRAME, w)):
        for y in range(0, h, 3):
            r, g, b, a = px[x, y]
            if a >= OPAQUE:
                seen.add((r // 16 * 16 + 8, g // 16 * 16 + 8, b // 16 * 16 + 8))
    return sorted(seen)


for i in range(1, count + 1):
    im = Image.open(f"{src}/img{i}.png").convert("RGBA")
    w, h = im.size
    px = im.load()
    palette = border_colours(im)

    # THE SOLID BODY OF THE DRAWING, as a bounding box. A per-pixel test with a generous threshold,
    # which is the whole difference from the flood fill this replaced: nothing is traced, so no
    # antialiased gradient can be walked across in small steps, and no region can fail to be
    # reached. The outermost solid thing in every one of these sources is the rim, and a rim is a
    # full circle — so the box is tight, symmetric, and gives the centre as well as the radius.
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < OPAQUE:
                continue
            solid = True
            for qr, qg, qb in palette:
                if abs(r - qr) + abs(g - qg) + abs(b - qb) < SOLID:
                    solid = False
                    break
            if not solid:
                continue
            if x < x0: x0 = x
            if x > x1: x1 = x
            if y < y0: y0 = y
            if y > y1: y1 = y

    if x1 < 0:
        raise SystemExit(f"img{i}.png: nothing on this image is far enough from its own border")

    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    # THE LONGER HALF-SIDE, AND THE SHORTER ONE WAS TRIED FIRST. The box of a circle ought to be
    # square and these come out eight to forty pixels wider than they are tall, because four of the
    # six carry a DROP SHADOW offset down and to the right — real drawing, outside the rim, on two
    # sides only. Taking the shorter side to avoid it cost img4 its entire coral rim: its box is
    # 1146 wide and 1124 tall, the rim is thirteen pixels thick, and eleven of those are what the
    # shorter side threw away.
    #
    # SO THE RULE IS "NEVER CLIP THE RIM", and the cost of the other side of it is nothing that can
    # be seen. On the two sources with real alpha the disc is not doing the cutting at all — their
    # own transparency already is, and the multiply below keeps it — so a disc a few percent wide of
    # their circle only widens a margin that was already invisible. On the four opaque ones it means
    # a sliver of backdrop can survive in the corners of the shadow's quadrant, which is one or two
    # source pixels out of 1150 and vanishes in the nine-fold downscale.
    radius = max(x1 - x0, y1 - y0) / 2.0 + BLEND
    print(f"img{i}.png circle at ({cx:.0f},{cy:.0f}) r={radius:.0f} "
          f"box={x1-x0}x{y1-y0} border={len(palette)} colours")

    # A clean antialiased disc, drawn big and brought down.
    mask = Image.new("L", (w * SS, h * SS), 0)
    ImageDraw.Draw(mask).ellipse(
        [(cx - radius) * SS, (cy - radius) * SS, (cx + radius) * SS, (cy + radius) * SS],
        fill=255,
    )
    mask = mask.resize((w, h), Image.LANCZOS)

    # THE ARTWORK'S OWN ALPHA IS MULTIPLIED IN RATHER THAN REPLACED, so img2 and img6 — the two that
    # really are transparent — keep whatever holes they already had instead of having them filled
    # with the opaque disc.
    cut = im.copy()
    cut.putalpha(ImageChops.multiply(im.getchannel("A"), mask))

    # Cropped to the circle's own square before the resize, so every badge fills its box identically
    # and the row's spacing is the geometry rather than six different amounts of padding.
    box = (round(cx - radius), round(cy - radius), round(cx + radius), round(cy + radius))
    cut = cut.crop(box).resize((badge, badge), Image.LANCZOS)
    cut.save(f"{dst}/empty-{i:02d}.png", optimize=True)

print(f"wrote {count} badges")
`;

execFileSync("python3", ["-c", script, SOURCES, OUT, String(COUNT), String(BADGE)], {
  stdio: "inherit",
});

const entries = Array.from({ length: COUNT }, (_, i) => {
  const id = `empty-${String(i + 1).padStart(2, "0")}`;
  return `  { id: "${id}", file: "${id}.png" },`;
}).join("\n");

writeFileSync(
  join(CLIENT, "src", "lib", "emptyFaceFiles.ts"),
  `// GENERATED by scripts/gen-empty-faces.mjs. Do not edit by hand.
//
// The six badges in \`public/empty-faces/\`, in source order, as a typed list. Built at BUILD TIME
// rather than read from a directory at runtime for \`agentFaceFiles.ts\`'s reason: a browser cannot
// list a directory, and a server that could would be answering a question whose answer must be
// identical on every replica.
//
// THE ORDER IS THE DESIGN. The product owner asked for img1 through img6 in that order and named
// shuffling as the thing not to do, so the row draws this list front to back and nothing sorts,
// rotates or randomises it. The ids are zero-padded precisely so that "source order" and "sorted
// order" are the same sequence on every platform — directory iteration order is not stable across
// them, and this project has already been bitten once by a platform-dependent path.
//
// \`test:empty-faces\` asserts this matches what is actually in \`public/empty-faces\`.

export interface EmptyFaceFile {
  /** Stable id, and the basename without its extension. */
  readonly id: string;
  /** The badge: a circular illustration, transparent outside its own rim. */
  readonly file: string;
}

export const EMPTY_FACE_FILES: readonly EmptyFaceFile[] = [
${entries}
];
`,
);

console.log(`wrote ${COUNT} badges to public/empty-faces and src/lib/emptyFaceFiles.ts`);
