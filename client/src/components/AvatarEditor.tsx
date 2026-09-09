// Choose a picture, frame it, save it. The whole of the avatar's editing surface.
//
// NO DEPENDENCY, AND THE REASON IS PROPORTION RATHER THAN PURITY. A cropper library is 40–120KB to
// solve a problem whose whole statement is "let somebody choose which square of an image to keep":
// one draw call, a drag, a wheel, and `toBlob`. What libraries add beyond that — rotation, aspect
// presets, touch gestures, EXIF orientation — this product does not ask for, and the one that
// matters (orientation) is handled by `createImageBitmap` below for free.
//
// THE OUTPUT IS ALWAYS A 512×512 PNG, whatever came in. That is the single decision that keeps the
// rest of the system simple: the server sniffs three formats but never has to convert one, the
// store holds a predictable few hundred kilobytes, and a 20MP phone photo becomes an avatar rather
// than becoming a 20MP file on somebody's S3 bill. 512 because the footer draws it at 20px and a
// retina display at 2x is 40 — the headroom is for wherever this lands next.
//
// WHAT IS DELIBERATELY ABSENT IS A ROTATE CONTROL. It is the obvious fourth feature and it would
// need a second transform in the draw, a second gesture, and a reset — for a case that
// `createImageBitmap`'s EXIF handling already covers for the photos people actually upload.

import { useCallback, useEffect, useRef, useState } from "react";
import { secondaryBtn } from "./buttons.ts";
import { TYPE } from "../lib/tokens.ts";

/** The square the crop is rendered into, and what the server receives. See the file header. */
const OUTPUT = 512;
/** The editor's on-screen size. Independent of `OUTPUT` — this is a viewport, not the image. */
const VIEW = 220;

export function AvatarEditor({
  file,
  onCancel,
  onSave,
}: {
  file: File;
  onCancel: () => void;
  onSave: (blob: Blob) => void | Promise<void>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bitmapRef = useRef<ImageBitmap | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Zoom as a multiple of the fit-to-frame scale, so 1 always means "fills the circle". */
  const [zoom, setZoom] = useState(1);
  /** Offset from centre, in VIEW pixels. Clamped on every commit — see `clamp`. */
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  // `createImageBitmap` RATHER THAN `new Image()` + object URL: it decodes off the main thread, it
  // applies EXIF orientation (which is why there is no rotate control), and it hands back something
  // `drawImage` takes directly with no load event to race.
  useEffect(() => {
    let live = true;
    let made: ImageBitmap | null = null;
    void (async () => {
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
        made = bitmap;
        if (!live) { bitmap.close(); return; }
        bitmapRef.current = bitmap;
        setReady(true);
      } catch {
        if (live) setError("that file could not be read as an image");
      }
    })();
    return () => {
      live = false;
      // Closing frees the decoded bitmap immediately rather than at the next GC, which matters
      // when somebody is trying three photos in a row.
      if (made) made.close();
      bitmapRef.current = null;
    };
  }, [file]);

  /**
   * The scale at which the image exactly covers the frame — `cover`, not `contain`.
   *
   * A crop must never show empty corners, so the base scale is set by the SHORTER edge and the
   * longer one overflows. `zoom` multiplies this, and it never goes below 1, which is what makes
   * "no gap" an invariant rather than something the clamp has to keep rescuing.
   */
  const baseScale = useCallback((bitmap: ImageBitmap): number =>
    Math.max(VIEW / bitmap.width, VIEW / bitmap.height), []);

  /** How far the image may be dragged before a corner would come into frame. */
  const clamp = useCallback((next: { x: number; y: number }, z: number): { x: number; y: number } => {
    const bitmap = bitmapRef.current;
    if (!bitmap) return next;
    const s = baseScale(bitmap) * z;
    const slackX = Math.max(0, (bitmap.width * s - VIEW) / 2);
    const slackY = Math.max(0, (bitmap.height * s - VIEW) / 2);
    return {
      x: Math.min(slackX, Math.max(-slackX, next.x)),
      y: Math.min(slackY, Math.max(-slackY, next.y)),
    };
  }, [baseScale]);

  // The preview. Redrawn on every zoom or drag — cheap, because it is one `drawImage` into a
  // 220px canvas and the browser composites the rest.
  useEffect(() => {
    const canvas = canvasRef.current;
    const bitmap = bitmapRef.current;
    if (!canvas || !bitmap || !ready) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const s = baseScale(bitmap) * zoom;
    const w = bitmap.width * s;
    const h = bitmap.height * s;
    ctx.clearRect(0, 0, VIEW, VIEW);
    ctx.drawImage(bitmap, (VIEW - w) / 2 + offset.x, (VIEW - h) / 2 + offset.y, w, h);
  }, [ready, zoom, offset, baseScale]);

  const save = async (): Promise<void> => {
    const bitmap = bitmapRef.current;
    if (!bitmap || busy) return;
    setBusy(true);
    setError(null);
    try {
      // DRAWN AGAIN AT OUTPUT SIZE rather than scaled up from the preview, which would ship a
      // 220px image stretched to 512. The transform is the same one the preview uses, multiplied
      // by the ratio between the two squares.
      const scale = OUTPUT / VIEW;
      const out = document.createElement("canvas");
      out.width = OUTPUT;
      out.height = OUTPUT;
      const ctx = out.getContext("2d");
      if (!ctx) throw new Error("this browser cannot render a canvas");
      const s = baseScale(bitmap) * zoom * scale;
      const w = bitmap.width * s;
      const h = bitmap.height * s;
      ctx.drawImage(bitmap, (OUTPUT - w) / 2 + offset.x * scale, (OUTPUT - h) / 2 + offset.y * scale, w, h);
      // A SQUARE, NOT A CIRCLE. The mask below is a preview of how the footer draws it; baking a
      // transparent corner into the file would make the picture wrong the first time it is shown
      // anywhere with a different radius.
      const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("could not render that picture");
      await onSave(blob);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div
        className="relative select-none"
        style={{ width: VIEW, height: VIEW }}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          setOffset(clamp({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) }, zoom));
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
      >
        <canvas
          ref={canvasRef}
          width={VIEW}
          height={VIEW}
          className="cursor-grab rounded-full bg-chrome active:cursor-grabbing"
        />
        {/* The circle is the frame, drawn OVER the canvas rather than clipped into it, so the ring
            stays crisp while the image under it moves. `pointer-events-none` because the whole
            square is the drag target — a mask that ate the pointer would make the edges dead. */}
        <div className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-inset ring-grip" />
      </div>

      <label className="flex items-center gap-2">
        <span className={TYPE.meta}>Zoom</span>
        <input
          type="range"
          min={1}
          max={4}
          step={0.01}
          value={zoom}
          disabled={!ready || busy}
          onChange={(e) => {
            const next = Number(e.target.value);
            setZoom(next);
            // RE-CLAMPED ON ZOOM OUT, and this is the bug it prevents: drag to a corner at 4x, zoom
            // back to 1x, and the offset that was legal is now further than the image can go — so
            // the frame shows empty. Clamping here keeps "no gap" true at every zoom.
            setOffset((o) => clamp(o, next));
          }}
          className="min-w-0 flex-1 accent-ink"
          aria-label="Zoom"
        />
      </label>

      {error && <p className="text-caption text-err">{error}</p>}

      <div className="flex gap-2">
        <button type="button" onClick={() => void save()} disabled={!ready || busy} className={secondaryBtn}>
          {busy ? "Saving…" : "Save picture"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="text-caption text-muted underline underline-offset-2 transition-colors hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
