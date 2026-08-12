// A tar writer, in ninety lines, because the alternative was a dependency in the export path.
//
// WHY TAR AND NOT ZIP. Zip needs deflate to be worth anything, and deflate means zlib bindings
// and a central directory written after the fact — which means holding the whole archive to
// finish it. Tar is a header and some padding per file, in order, and the result is a format
// every operating system on earth already opens. An export that has to be unpacked with a
// specific tool is not portability.
//
// UNCOMPRESSED, DELIBERATELY. Node can gzip the finished buffer in one call if a deployment
// wants that, and doing it here would put a compression level and a memory profile inside the
// thing whose only job is layout. The content is NDJSON, which gzips at about 90% — worth doing
// at the edge, not worth entangling with the archive.
//
// USTAR, WHICH IS THE OLD FORMAT AND THE RIGHT ONE. It caps a path at 100 bytes and a size at 8
// GB, and both limits are checked rather than silently truncated — a tar whose entry names are
// quietly cut in half is a tar that unpacks into the wrong files. Longer paths would need the
// PAX extension, and the day an export needs one is the day this grows a second header type,
// visibly, rather than the day somebody's agent file lands under a different name.

/** One entry: a path inside the archive, and its bytes. */
export interface TarEntry {
  path: string;
  body: Buffer | string;
  /** Unix mtime in seconds. Fixed by the caller so an export is byte-reproducible. */
  mtimeSec?: number;
}

const BLOCK = 512;
/** ustar's own limit. Checked, never truncated — see the header. */
const MAX_PATH = 100;

/**
 * The whole archive, as one buffer.
 *
 * In memory, and that is a bounded decision rather than an oversight: an export is capped by
 * what a workspace's retention holds, the caller streams nothing today, and a Buffer is what the
 * ObjectStore's `put` takes. The moment an export is large enough for this to matter, `put`
 * needs a stream first — and that is a change to the storage interface, not to this file.
 */
export function tar(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body, "utf8");
    blocks.push(header(entry.path, body.length, entry.mtimeSec ?? 0));
    blocks.push(body);
    const remainder = body.length % BLOCK;
    if (remainder !== 0) blocks.push(Buffer.alloc(BLOCK - remainder));
  }
  // Two empty blocks mark the end of an archive. Without them `tar` reports an unexpected EOF,
  // which reads to a user as a corrupt download rather than as a missing terminator.
  blocks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(blocks);
}

function header(path: string, size: number, mtimeSec: number): Buffer {
  const name = Buffer.from(path, "utf8");
  if (name.length > MAX_PATH) {
    throw new Error(`tar path is longer than ustar's ${MAX_PATH} bytes: ${path}`);
  }
  if (path.startsWith("/") || path.includes("..")) {
    // An archive that unpacks outside the directory it was unpacked in is the oldest trick
    // there is. Nothing here builds such a path, and refusing one is cheaper than being sure.
    throw new Error(`tar path must be relative and free of "..": ${path}`);
  }
  if (size > 0o77777777777) throw new Error(`tar entry is larger than ustar's 8 GB limit: ${path}`);

  const h = Buffer.alloc(BLOCK);
  h.write(path, 0, MAX_PATH, "utf8");
  h.write(octal(0o644, 7), 100); // mode
  h.write(octal(0, 7), 108); // uid — zero, so an export is not attributed to a server's user
  h.write(octal(0, 7), 116); // gid
  h.write(octal(size, 11), 124);
  h.write(octal(mtimeSec, 11), 136);
  h.write("        ", 148); // checksum field, spaces while it is computed
  h.write("0", 156); // typeflag: a regular file
  h.write("ustar\0", 257);
  h.write("00", 263);

  // The checksum is the sum of every byte of the header with the checksum field read as spaces,
  // which is why it is written last and why the field was filled with spaces above.
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}

/** A fixed-width octal field, NUL-terminated, as ustar wants it. */
function octal(value: number, width: number): string {
  return `${Math.floor(value).toString(8).padStart(width, "0")}\0`;
}
