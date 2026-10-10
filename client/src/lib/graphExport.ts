// The graph as a picture: copied to the clipboard, or saved as a PNG or an SVG.
//
// THE PICTURE IS THE GRAPH, NOT THE VIEW OF IT. What is on screen may be panned half off the canvas
// or zoomed out to fit a narrow column; an export frames every node, edge and label at real size,
// whatever the view, with a margin of canvas around it. The frame is read off the drawn elements
// rather than the layout, because what the eye sees — a time chip beside a tile, a loop's lane out
// to the left, a branch's label — reaches past the nodes' boxes.
//
// ON THE CANVAS COLOUR, read from the canvas itself, so a dark export is dark and no colour is
// written here. The dot grid is left out: it is the surface to work on, not part of the agent.

import { toBlob, toSvg } from "html-to-image";

/** Canvas left around the graph, in real-size pixels. */
const MARGIN = 32;
/** Twice real size, so the PNG is sharp on a Retina screen and in a slide. */
const PIXEL_RATIO = 2;

/** Everything a person sees of the graph: the nodes and all inside them, the edges, their labels. */
const DRAWN = ".react-flow__node, .react-flow__node *, .react-flow__edge path, .react-flow__edgelabel-renderer *";

interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The drawn graph's box in flow coordinates — at zoom 1 with the viewport at the origin. */
function frameOf(viewport: HTMLElement): Frame | null {
  const origin = viewport.getBoundingClientRect();
  const zoom = new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a || 1;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const el of viewport.querySelectorAll(DRAWN)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    x0 = Math.min(x0, (r.left - origin.left) / zoom);
    y0 = Math.min(y0, (r.top - origin.top) / zoom);
    x1 = Math.max(x1, (r.right - origin.left) / zoom);
    y1 = Math.max(y1, (r.bottom - origin.top) / zoom);
  }
  if (!Number.isFinite(x0)) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function shotOf(canvas: HTMLElement) {
  const viewport = canvas.querySelector<HTMLElement>(".react-flow__viewport");
  const frame = viewport && frameOf(viewport);
  if (!viewport || !frame) throw new Error("There is no graph on the canvas to export.");
  const width = Math.ceil(frame.width + MARGIN * 2);
  const height = Math.ceil(frame.height + MARGIN * 2);
  return {
    viewport,
    options: {
      backgroundColor: getComputedStyle(canvas).backgroundColor,
      width,
      height,
      pixelRatio: PIXEL_RATIO,
      // The copy is drawn from the viewport's clone, moved so the frame's corner is the margin's.
      style: {
        width: `${width}px`,
        height: `${height}px`,
        transform: `translate(${MARGIN - frame.x}px, ${MARGIN - frame.y}px) scale(1)`,
      },
    },
  };
}

/** The graph as a PNG. */
export async function graphPng(canvas: HTMLElement): Promise<Blob> {
  const { viewport, options } = shotOf(canvas);
  const blob = await toBlob(viewport, options);
  if (!blob) throw new Error("The graph could not be drawn.");
  return blob;
}

/** The graph as an SVG document. */
export async function graphSvg(canvas: HTMLElement): Promise<string> {
  const { viewport, options } = shotOf(canvas);
  const url = await toSvg(viewport, options);
  return decodeURIComponent(url.slice(url.indexOf(",") + 1));
}

/** `liven-graph-v3`: the agent and the version the picture is of — `-v1-vs-v3` for a comparison. */
export function graphFileStem(agentName: string, version: number | null, against: number | null = null): string {
  const slug = agentName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  return `${slug}-graph${version ? `-v${version}` : ""}${version && against ? `-vs-v${against}` : ""}`;
}
