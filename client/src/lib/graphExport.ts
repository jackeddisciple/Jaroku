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
  // One format of each face: every browser that opens an SVG reads woff2, and the woff beside it
  // doubled what the fonts cost.
  const url = await toSvg(viewport, { ...options, preferredFontFormat: "woff2" });
  return compactSvg(decodeURIComponent(url.slice(url.indexOf(",") + 1)));
}

/**
 * The SVG with every inline style declaration that changes nothing taken out.
 *
 * 1.8 MB FOR SEVEN STEPS, AND NOT MOSTLY FONTS. html-to-image writes each element's whole computed
 * style onto its copy — some three hundred properties, nearly all of them what the element would
 * have anyway — and the graph is a hundred and seventy elements. So the copy is laid out in a page of
 * its own with no stylesheet, and each declaration is kept only if the element would compute
 * something else without it: measured against a bare element of the same kind in the same place,
 * which is exactly what the element becomes once its declaration is gone. What is left draws the same
 * picture.
 */
function compactSvg(svg: string): string {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  const content = parsed.querySelector("foreignObject")?.firstElementChild;
  if (!content || typeof document === "undefined") return svg;
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;left:-10000px;top:0;width:4000px;height:4000px;border:0;visibility:hidden";
  document.body.appendChild(frame);
  try {
    // STANDARDS MODE, as the SVG's own XHTML is drawn in: a doctype-less about:blank is quirks mode,
    // where a few properties compute differently, and a declaration judged redundant there could
    // matter in the picture.
    frame.contentDocument?.open();
    frame.contentDocument?.write("<!DOCTYPE html><html><head></head><body></body></html>");
    frame.contentDocument?.close();
    const page = frame.contentDocument;
    const win = frame.contentWindow;
    if (!page || !win || page.compatMode !== "CSS1Compat") return svg;
    const root = page.importNode(content, true) as Element;
    page.body.appendChild(root);
    const trim = (el: Element): void => {
      const style = (el as HTMLElement).style as CSSStyleDeclaration | undefined;
      const parent = el.parentElement;
      if (style && style.length && parent) {
        const bare = page.createElementNS(el.namespaceURI, el.localName);
        parent.insertBefore(bare, el);
        const plain = win.getComputedStyle(bare);
        const redundant = new Map<string, string>();
        for (let i = 0; i < style.length; i++) {
          const name = style.item(i);
          const value = style.getPropertyValue(name);
          if (value === plain.getPropertyValue(name)) redundant.set(name, value);
        }
        bare.remove();
        for (const name of redundant.keys()) style.removeProperty(name);
        // AND CHECKED, because properties lean on each other: a border width of 0 is what a bare
        // element computes only because its border style is `none`, so with the copied `solid` kept
        // and the width taken out it drew 3px borders round everything. Whatever no longer computes
        // to what it was is put back, until nothing moves.
        for (let pass = 0; pass < 4 && redundant.size; pass++) {
          const now = win.getComputedStyle(el);
          let restored = false;
          for (const [name, value] of redundant) {
            if (now.getPropertyValue(name) !== value) {
              style.setProperty(name, value);
              redundant.delete(name);
              restored = true;
            }
          }
          if (!restored) break;
        }
      }
      for (const child of Array.from(el.children)) trim(child);
    };
    trim(root);
    content.replaceWith(parsed.importNode(root, true));
    return new XMLSerializer().serializeToString(parsed);
  } catch {
    return svg; // a bigger file that draws is better than none
  } finally {
    frame.remove();
  }
}

/** `liven-graph-v3`: the agent and the version the picture is of — `-v1-vs-v3` for a comparison. */
export function graphFileStem(agentName: string, version: number | null, against: number | null = null): string {
  const slug = agentName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  return `${slug}-graph${version ? `-v${version}` : ""}${version && against ? `-vs-v${against}` : ""}`;
}
