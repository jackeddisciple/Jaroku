// The desktop app's icon set, rendered from `client/public/favicon.svg`.
//
// WHY THIS EXISTS RATHER THAN A DIRECTORY OF CHECKED-IN PNGs SOMEBODY EXPORTED. The mark has
// been redrawn once already — v0.2.2 replaced an outlined amber triangle because in an app where
// amber means running it read as a warning sign — and the thing that makes a redraw safe is that
// every rendering of the mark comes from ONE source. The tab icon and the dock icon are the same
// three contours here by construction; exported separately they are the same three contours
// until the day somebody re-exports one of them.
//
// AND WHY IT IS NOT `tauri icon`. That command is the ordinary way to do this and it works; it
// also takes a 1024px PNG this repository does not have, which would mean checking in a raster
// of a vector — the exact second copy the paragraph above is about. Everything below is
// `node:zlib` and arithmetic: no dependency, no install step, and it runs on a machine with no
// Rust toolchain, which is the machine most of this wrapper was written on.
//
// Run it with `node scripts/tauri/gen-icons.mjs` from the repository root, or through the
// `tauri:icons` alias the desktop scripts add there. It is deterministic: re-running it on an
// unchanged favicon rewrites the same bytes, so a diff here means the mark itself moved.

import { deflateSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE = join(ROOT, "client", "public", "favicon.svg");
const OUT = join(ROOT, "src-tauri", "icons");

// ---------------------------------------------------------------------------------------------
// Reading the source.
//
// A deliberately narrow SVG reader: the rounded rectangle, one transform, and paths built from
// `M`, `C` and `Z`. It THROWS on anything it does not recognise rather than skipping it, because
// the failure this guards against is a redrawn logo whose new command silently drops a contour —
// an icon that is subtly wrong everywhere is worse than a generator that refuses to run.
// ---------------------------------------------------------------------------------------------

function readSource() {
  const svg = readFileSync(SOURCE, "utf8");

  const view = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  if (!view) throw new Error("favicon.svg: no viewBox — this reader assumes one starting at 0 0");
  const units = Number(view[1]);
  if (Number(view[2]) !== units) throw new Error("favicon.svg: the viewBox is not square");

  const rect = /<rect[^>]*rx="([\d.]+)"[^>]*fill="(#[0-9a-fA-F]{6})"/.exec(svg);
  if (!rect) throw new Error("favicon.svg: no background rect with an rx and a fill");

  const group =
    /<g[^>]*fill="(#[0-9a-fA-F]{6})"[^>]*transform="translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)"/.exec(svg);
  if (!group) throw new Error("favicon.svg: the mark's <g> is not the translate+scale shape this reader knows");

  const paths = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
  if (paths.length !== 3) throw new Error(`favicon.svg: expected the mark's three contours, found ${paths.length}`);

  return {
    units,
    radius: Number(rect[1]),
    background: hex(rect[2]),
    ink: hex(group[1]),
    translate: [Number(group[2]), Number(group[3])],
    scale: Number(group[4]),
    paths,
  };
}

function hex(s) {
  return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
}

/** `M`/`C`/`Z` into a list of closed polygons, in the SVG's own user units. */
function flatten(d, translate, scale) {
  const tokens = d.match(/[MCZmcz]|-?\d*\.?\d+/g) ?? [];
  const map = (x, y) => [translate[0] + x * scale, translate[1] + y * scale];

  const polygons = [];
  let current = null;
  let cursor = [0, 0];
  let start = [0, 0];

  for (let i = 0; i < tokens.length; ) {
    const op = tokens[i++];
    if (op === "M" || op === "m") {
      if (current && current.length > 2) polygons.push(current);
      const p = map(Number(tokens[i++]), Number(tokens[i++]));
      current = [p];
      cursor = p;
      start = p;
    } else if (op === "C" || op === "c") {
      const c1 = map(Number(tokens[i++]), Number(tokens[i++]));
      const c2 = map(Number(tokens[i++]), Number(tokens[i++]));
      const end = map(Number(tokens[i++]), Number(tokens[i++]));
      // Segment count from the control polygon's length rather than a constant: these contours
      // are hundreds of short curves, and twenty segments on each of them is a million points
      // that render identically to four.
      const span = dist(cursor, c1) + dist(c1, c2) + dist(c2, end);
      const steps = Math.max(3, Math.min(24, Math.ceil(span * 4)));
      for (let s = 1; s <= steps; s++) current.push(cubic(cursor, c1, c2, end, s / steps));
      cursor = end;
    } else if (op === "Z" || op === "z") {
      if (current && current.length > 2) polygons.push(current);
      current = null;
      cursor = start;
    } else {
      throw new Error(`favicon.svg: path command ${op} is not one this reader knows how to draw`);
    }
  }
  if (current && current.length > 2) polygons.push(current);
  return polygons;
}

const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

function cubic(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

// ---------------------------------------------------------------------------------------------
// Rasterising.
//
// Coverage is sampled on a grid `factor` times finer than the output and box-filtered down,
// which is the cheapest antialiasing that does not make a 32px mark look chewed. Winding is
// NONZERO, matching `fill-rule`'s default — these three contours do not overlap today, but a
// mark that gained a counter would render as a hole under even-odd and as solid under nonzero,
// and the SVG's own default is the one to agree with.
// ---------------------------------------------------------------------------------------------

function render(source, size) {
  const factor = size >= 512 ? 2 : 4;
  const n = size * factor;
  const unitsPerSample = source.units / n;

  const polygons = source.paths.flatMap((d) => flatten(d, source.translate, source.scale));
  const edges = [];
  for (const poly of polygons) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (a[1] !== b[1]) edges.push([a[0], a[1], b[0], b[1]]);
    }
  }

  // Two accumulators rather than one image: the mark is drawn over the plate, and keeping them
  // apart means the plate's rounded corner is antialiased against transparency while the mark is
  // antialiased against the plate — compositing them per SAMPLE, before the box filter, which is
  // the only order that does not leave a dark fringe around the mark at 32px.
  const plate = new Float32Array(size * size);
  const ink = new Float32Array(size * size);
  const weight = 1 / (factor * factor);

  let xs = [];
  for (let row = 0; row < n; row++) {
    const y = (row + 0.5) * unitsPerSample;

    xs.length = 0;
    for (const [x0, y0, x1, y1] of edges) {
      if ((y >= y0 && y < y1) || (y >= y1 && y < y0)) {
        xs.push([x0 + ((y - y0) / (y1 - y0)) * (x1 - x0), y1 > y0 ? 1 : -1]);
      }
    }
    xs.sort((a, b) => a[0] - b[0]);

    const outRow = (row / factor) | 0;
    let winding = 0;
    let span = 0;
    for (let col = 0; col < n; col++) {
      const x = (col + 0.5) * unitsPerSample;
      while (span < xs.length && xs[span][0] <= x) winding += xs[span++][1];
      const cell = outRow * size + ((col / factor) | 0);
      if (insidePlate(x, y, source)) plate[cell] += weight;
      if (winding !== 0) ink[cell] += weight;
    }
  }

  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const alpha = Math.min(1, plate[i]);
    const mark = Math.min(1, ink[i]);
    for (let c = 0; c < 3; c++) {
      rgba[i * 4 + c] = Math.round(source.background[c] * (1 - mark) + source.ink[c] * mark);
    }
    rgba[i * 4 + 3] = Math.round(alpha * 255);
  }
  return rgba;
}

/** The rounded rectangle, as a predicate rather than as a path: it is four line segments and
 *  four quarter-circles, and stating it directly is shorter and exact at every size. */
function insidePlate(x, y, { units, radius: r }) {
  if (x < 0 || y < 0 || x > units || y > units) return false;
  const cx = x < r ? r : x > units - r ? units - r : x;
  const cy = y < r ? r : y > units - r ? units - r : y;
  if (cx === x || cy === y) return true;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// ---------------------------------------------------------------------------------------------
// The three container formats. All of them carry the identical PNGs, which is why they are
// written from one buffer each rather than re-rendered per format.
// ---------------------------------------------------------------------------------------------

const CRC = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return (buf) => {
    let c = -1;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(CRC(body), body.length + 4);
  return out;
}

function png(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  // Every scanline gets filter type 0. A real encoder would choose per line and save perhaps a
  // fifth of the bytes; these files are counted in kilobytes and the deflate does the work.
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let row = 0; row < size; row++) {
    raw[row * stride] = 0;
    rgba.copy(raw, row * stride + 1, row * size * 4, (row + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Windows .ico, carrying PNG entries — accepted since Vista and the only sane way to hold a
 *  256px entry, whose width and height are written as 0 because the field is one byte. */
function ico(entries) {
  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  for (const [i, entry] of entries.entries()) {
    const at = 6 + i * 16;
    header[at] = entry.size >= 256 ? 0 : entry.size;
    header[at + 1] = entry.size >= 256 ? 0 : entry.size;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(entry.data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  }
  return Buffer.concat([header, ...entries.map((e) => e.data)]);
}

/** macOS .icns. Every type below is a PNG-carrying one, so each chunk is a whole PNG file with
 *  an eight-byte header in front of it. */
function icns(entries) {
  const TYPES = { 32: "ic11", 64: "ic12", 128: "ic07", 256: "ic13", 512: "ic14", 1024: "ic10" };
  const chunks = entries.map((entry) => {
    const head = Buffer.alloc(8);
    head.write(TYPES[entry.size], 0, "latin1");
    head.writeUInt32BE(entry.data.length + 8, 4);
    return Buffer.concat([head, entry.data]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write("icns", 0, "latin1");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

// ---------------------------------------------------------------------------------------------

const source = readSource();
mkdirSync(OUT, { recursive: true });

// Rendered once per size and reused by every container below.
const SIZES = [32, 64, 128, 256, 512, 1024];
const rendered = new Map(SIZES.map((size) => [size, png(render(source, size), size)]));

const files = [
  ["32x32.png", rendered.get(32)],
  ["128x128.png", rendered.get(128)],
  // Tauri's own naming for the 2x asset; it is a 256px image and the name is what macOS reads.
  ["128x128@2x.png", rendered.get(256)],
  ["icon.png", rendered.get(1024)],
  ["icon.ico", ico([32, 64, 128, 256].map((size) => ({ size, data: rendered.get(size) })))],
  ["icon.icns", icns([32, 64, 128, 256, 512, 1024].map((size) => ({ size, data: rendered.get(size) })))],
];

for (const [name, data] of files) {
  writeFileSync(join(OUT, name), data);
  console.log(`${name.padEnd(18)} ${String(data.length).padStart(8)} bytes`);
}
