// The desktop app's icon set, rendered from the two PNGs in `assets/`.
//
// TWO PIECES OF ARTWORK, BECAUSE TWO PLACES WANT DIFFERENT THINGS. `mainlogo.png` is the logo:
// the mark on its orange plate, and what belongs in the dock, the Finder, the installer and the
// window. `mono.png` is the same animal as one flat silhouette on transparency, and it is what
// belongs in the macOS menu bar — where an icon is a TEMPLATE, recoloured by the system to match
// a light or dark bar and whatever the user has done to their accent colour. A plate in the menu
// bar is a coloured rectangle sitting in a row of glyphs; it is not a smaller version of the dock
// icon, it is the wrong thing. So there are two sources here and the tray gets its own file.
//
// WHY THE SOURCE IS A RASTER NOW. It used to be `client/public/favicon.svg`, on the reasoning that
// every rendering of the mark should come from ONE vector so a redraw could not leave half the
// product behind. That reasoning still holds and this file still honours it — there is exactly one
// source per destination and both are checked in — but the artwork itself arrived as PNG, and a
// vector traced from it would be a copy that drifts rather than a source. The tab icon keeps a
// vector because a favicon genuinely wants one; see `client/public/favicon.svg`.
//
// AND WHY IT IS NOT `tauri icon`. That command is the ordinary way to do this and it works; it
// also would not know about the menu bar's template icon, would not strip the black the artwork
// carries outside its plate, and would hand macOS 26 an icon with alpha in it — see the note on
// `ICNS` for what Tahoe does with one of those. Everything below is
// `node:zlib` and arithmetic: no dependency, no install step, and it runs on a machine with no
// Rust toolchain, which is the machine most of this wrapper was written on.
//
// Run it with `node scripts/tauri/gen-icons.mjs` from the repository root, or through the
// `tauri:icons` alias the desktop scripts add there. It is deterministic: re-running it on
// unchanged artwork rewrites the same bytes, so a diff here means the logo itself moved.

import { deflateSync, inflateSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOGO = join(ROOT, "assets", "mainlogo.png");
const MONO = join(ROOT, "assets", "mono.png");
const OUT = join(ROOT, "src-tauri", "icons");

// ---------------------------------------------------------------------------------------------
// Reading a PNG.
//
// A deliberately narrow decoder: 8-bit, non-interlaced, truecolour with or without alpha, which
// is what both files are and what an export of this artwork will be. It THROWS on anything else
// rather than guessing, because the failure this guards against is a re-export in some other
// shape being silently misread into an icon that is subtly wrong everywhere.
// ---------------------------------------------------------------------------------------------

/** @returns {{width: number, height: number, rgba: Buffer}} */
function decodePng(file) {
  const buf = readFileSync(file);
  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!SIGNATURE.every((b, i) => buf[i] === b)) throw new Error(`${file}: not a PNG`);

  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = 0;
  const idat = [];

  for (let at = 8; at < buf.length; ) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + length);
    at += length + 12;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colour = data[9];
      if (depth !== 8) throw new Error(`${file}: bit depth ${depth}, and this reader only knows 8`);
      if (colour !== 2 && colour !== 6) throw new Error(`${file}: colour type ${colour}, and this reader knows 2 (RGB) and 6 (RGBA)`);
      if (data[12] !== 0) throw new Error(`${file}: interlaced, and this reader reads one pass`);
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (!width) throw new Error(`${file}: no IHDR`);

  const channels = colour === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rgba = Buffer.alloc(width * height * 4);
  let prior = Buffer.alloc(stride);

  // Undo the per-scanline filters. The five of them are the whole of PNG's compression front end,
  // and each needs the reconstructed byte to its left and the reconstructed line above.
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)];
    const line = Buffer.from(raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prior[i];
      const c = i >= channels ? prior[i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`${file}: scanline filter ${filter} is not one of the five`);
      line[i] = value & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const from = x * channels;
      const to = (row * width + x) * 4;
      rgba[to] = line[from];
      rgba[to + 1] = line[from + 1];
      rgba[to + 2] = line[from + 2];
      rgba[to + 3] = channels === 4 ? line[from + 3] : 255;
    }
    prior = line;
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------------------------------------
// The plate.
//
// `mainlogo.png` is drawn edge to edge with SOLID BLACK in the four corners the rounded plate does
// not reach — which is correct in a design tool on a white board and is a black square in a dock.
// So the plate's own outline is measured off the artwork and everything outside it is cut to
// transparent. Measuring rather than hard-coding a radius means a redrawn plate with a different
// corner still produces a clean icon.
// ---------------------------------------------------------------------------------------------

/** How far in the plate's edge sits on each row of its top-left quadrant. The mark never reaches
 *  that corner, so the profile there is the plate and nothing else; the other three are mirrors
 *  of it, which is also what makes the result symmetrical when the artwork is not quite. */
function cornerProfile({ width, height, rgba }) {
  const plateish = (x, y) => {
    const at = (y * width + x) * 4;
    // The plate, whatever colour it is: anything that is not the near-black surround.
    return rgba[at] + rgba[at + 1] + rgba[at + 2] > 210;
  };

  const limit = Math.floor(Math.min(width, height) / 3);
  const profile = [];
  for (let y = 0; y < limit; y++) {
    let x = 0;
    while (x < limit && !plateish(x, y)) x++;
    if (x >= limit) throw new Error("mainlogo.png: no plate edge in the top-left quadrant");
    profile.push(x);
    if (x === 0) break;
  }
  if (profile.length < 2) throw new Error("mainlogo.png: the plate has no rounded corner to measure");
  return profile;
}

/** Coverage of the plate at a point, supersampled so the corner is antialiased rather than
 *  stepped — the corner is the only curved edge in the whole image and the only place it shows. */
function plateCoverage(profile, width, height, x, y, factor) {
  let hits = 0;
  for (let sy = 0; sy < factor; sy++) {
    for (let sx = 0; sx < factor; sx++) {
      const px = x + (sx + 0.5) / factor;
      const py = y + (sy + 0.5) / factor;
      const row = py < profile.length ? Math.floor(py) : py >= height - profile.length ? Math.floor(height - 1 - py) : -1;
      const inset = row >= 0 && row < profile.length ? profile[row] : 0;
      if (px >= inset && px <= width - inset) hits++;
    }
  }
  return hits / (factor * factor);
}

// ---------------------------------------------------------------------------------------------
// Resampling.
//
// A box filter over the source, on PREMULTIPLIED alpha. Premultiplying is not optional here: the
// artwork's transparent corner pixels still carry a colour, and averaging colour and alpha
// separately drags that colour into every edge pixel — which is the dark halo an icon gets when
// somebody scales it in the obvious way.
// ---------------------------------------------------------------------------------------------

/** Draw the whole of `src` into a `width` x `height` canvas. */
function resample(src, width, height) {
  const out = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    // The source window this destination pixel averages. Computed from the edges rather than from
    // a centre and a width so that consecutive pixels share a boundary exactly and no source row
    // is counted twice or skipped.
    const y0 = (y * src.height) / height;
    const y1 = ((y + 1) * src.height) / height;
    for (let x = 0; x < width; x++) {
      const x0 = (x * src.width) / width;
      const x1 = ((x + 1) * src.width) / width;

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weight = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const cy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const cx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          const w = cx * cy;
          const at = (sy * src.width + sx) * 4;
          const alpha = src.rgba[at + 3] / 255;
          r += src.rgba[at] * alpha * w;
          g += src.rgba[at + 1] * alpha * w;
          b += src.rgba[at + 2] * alpha * w;
          a += alpha * w;
          weight += w;
        }
      }
      if (weight === 0) continue;
      const alpha = a / weight;
      const to = (y * width + x) * 4;
      // Back out of premultiplied space for storage; PNG wants straight alpha.
      out[to] = alpha > 0 ? Math.round(Math.min(255, r / weight / alpha)) : 0;
      out[to + 1] = alpha > 0 ? Math.round(Math.min(255, g / weight / alpha)) : 0;
      out[to + 2] = alpha > 0 ? Math.round(Math.min(255, b / weight / alpha)) : 0;
      out[to + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

/** The logo in two finishes, at the artwork's own resolution: `rounded` keeps the plate's shape
 *  and cuts the black surround to transparency, `opaque` extends the plate colour into the corners
 *  so the image is a solid square. Which one a platform wants is the comment above `OPAQUE_MACOS`. */
function plated() {
  const src = decodePng(LOGO);
  if (src.width !== src.height) throw new Error("mainlogo.png: the logo is not square");
  const profile = cornerProfile(src);

  // The plate's own colour, read from the top edge between the two corners — which is plate and
  // nothing else — rather than named here, so a replate does not need this file edited.
  const mid = ((3 * src.width) + (src.width >> 1)) * 4;
  const plate = [src.rgba[mid], src.rgba[mid + 1], src.rgba[mid + 2]];

  const rounded = Buffer.from(src.rgba);
  const opaque = Buffer.from(src.rgba);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const coverage = plateCoverage(profile, src.width, src.height, x, y, 4);
      if (coverage === 1) continue;
      const at = (y * src.width + x) * 4;
      rounded[at + 3] = Math.round(coverage * 255);
      // The corner, filled rather than cut: blend the surround out at the plate's own edge so the
      // seam is not a hard line where the antialiasing used to be.
      for (let c = 0; c < 3; c++) opaque[at + c] = plate[c];
      opaque[at + 3] = 255;
    }
  }
  const base = { width: src.width, height: src.height };
  return { rounded: { ...base, rgba: rounded }, opaque: { ...base, rgba: opaque }, corner: profile[0] / src.width };
}

/** The menu bar's mark: the silhouette alone, as a template image. Every pixel is black and only
 *  alpha carries the shape, because that is what macOS reads a template icon's bytes as — it
 *  throws the colour away and redraws the coverage in the bar's own ink.
 *
 *  CROPPED TO THE INK, and that is the whole reason this is not just a resize. `tray-icon` draws
 *  whatever it is given at a FIXED 18pt tall with the width scaled to match (its macOS backend
 *  hard-codes `icon_height: f64 = 18.0`). So the mark's height on screen is 18pt times its share
 *  of the image, and mono.png's own margins — the mark is 828 of 1254 tall — were spending nearly
 *  half of that on nothing. Cropped, the 18pt is all mark, which is the size a menu bar glyph is
 *  meant to be. It also means this image is WIDER THAN IT IS TALL, as the animal is; the bar is
 *  sized by height and takes the width it is given. */
function template(height) {
  const src = decodePng(MONO);

  let minX = src.width;
  let minY = src.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      if (src.rgba[(y * src.width + x) * 4 + 3] < 128) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error("mono.png: no opaque pixels, so there is no mark to crop to");

  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const cropped = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    src.rgba.copy(cropped, y * cw * 4, ((y + minY) * src.width + minX) * 4, ((y + minY) * src.width + maxX + 1) * 4);
  }

  const width = Math.round((height * cw) / ch);
  const out = resample({ width: cw, height: ch, rgba: cropped }, width, height);
  for (let i = 0; i < width * height; i++) {
    out[i * 4] = 0;
    out[i * 4 + 1] = 0;
    out[i * 4 + 2] = 0;
  }
  return { rgba: out, width, height };
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

function png(rgba, width, height = width) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  // Every scanline gets filter type 0. A real encoder would choose per line and save perhaps a
  // fifth of the bytes; these files are counted in kilobytes and the deflate does the work.
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(height * stride);
  for (let row = 0; row < height; row++) {
    raw[row * stride] = 0;
    rgba.copy(raw, row * stride + 1, row * width * 4, (row + 1) * width * 4);
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

// A LEGACY .icns ON macOS 26 MUST BE FULLY OPAQUE. Tahoe composites an app icon it is given into
// its own squircle and draws the shadow itself — but only when the image fills the canvas. Hand it
// anything with alpha, including nothing more than the plate's own rounded corners, and it decides
// the icon is a small graphic rather than an icon and drops it onto a light backing plate: the mark
// shrinks, gains a white border, and reads noticeably smaller than every icon beside it. Verified
// on 26.6.2 — inset-to-Apple's-grid and full-bleed-with-rounded-corners BOTH plate; only the solid
// square fills the tile. So the corners go to the plate colour and macOS rounds them back.
//
// WINDOWS AND LINUX DO NOT MASK, so their icons keep the plate's own rounded corners and the
// transparency outside them — a solid square there would be a square icon.
const ICNS = "opaque";
const OTHERS = "rounded";

// The menu bar's mark is sized by `tray-icon` at a fixed 18pt tall; see `template`. Rendering the
// 1x at 18 and the 2x at 36 means the bitmap lands on whole pixels on both kinds of display.
const TRAY_HEIGHT = 18;

const logo = plated();
mkdirSync(OUT, { recursive: true });

const SIZES = [32, 64, 128, 256, 512, 1024];
const square = (finish, size) => png(resample(logo[finish], size, size), size);
const rounded = new Map(SIZES.map((size) => [size, square(OTHERS, size)]));
const opaque = new Map(SIZES.map((size) => [size, square(ICNS, size)]));

const tray1x = template(TRAY_HEIGHT);
const tray2x = template(TRAY_HEIGHT * 2);

const files = [
  ["32x32.png", rounded.get(32)],
  ["128x128.png", rounded.get(128)],
  // Tauri's own naming for the 2x asset; it is a 256px image and the name is what macOS reads.
  ["128x128@2x.png", rounded.get(256)],
  ["icon.png", rounded.get(1024)],
  ["icon.ico", ico([32, 64, 128, 256].map((size) => ({ size, data: rounded.get(size) })))],
  ["icon.icns", icns(SIZES.map((size) => ({ size, data: opaque.get(size) })))],
  // The menu bar's two, at 1x and 2x. `tray.rs` compiles the 2x one in and lets macOS halve it,
  // which is sharper on every display made in the last decade than sending the 1x and letting a
  // Retina bar double it.
  ["tray.png", png(tray1x.rgba, tray1x.width, tray1x.height)],
  ["tray@2x.png", png(tray2x.rgba, tray2x.width, tray2x.height)],
];

for (const [name, data] of files) {
  writeFileSync(join(OUT, name), data);
  console.log(`${name.padEnd(18)} ${String(data.length).padStart(8)} bytes`);
}
console.log(`\nplate corner measured at ${(logo.corner * 100).toFixed(1)}% of the artwork's width`);
console.log(`menu bar mark ${tray2x.width}x${tray2x.height} at 2x, drawn ${TRAY_HEIGHT}pt tall`);
