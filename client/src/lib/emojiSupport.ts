// Whether this machine draws an emoji as an emoji — asked once, in a canvas, before the greeting
// cycles through the product owner's twenty-five.
//
// WHY IT HAS TO ASK. macOS draws every one of them; a Windows or Linux font may not. A Linux box
// without a colour emoji font draws a box, an older font draws a newer emoji (the potted plant is
// Unicode 13) the same way, and a font that does not know a joined sequence draws its parts side by
// side — a woman and a laptop for "woman technologist". Any of those in the middle of the greeting
// is worse than that emoji not being in the cycle.
//
// TWO FILLS, ONE PICTURE. A colour emoji is painted from the font's own artwork, so the fill colour
// never reaches it; a stand-in — a box, a monochrome outline — is painted in the fill colour. Drawn
// once in red and once in blue, a colour emoji comes out pixel-identical and a stand-in does not.
//
// AND ONE GLYPH, NOT TWO. A joined sequence the font does not know is drawn as colour parts, which
// the fill test cannot tell from the real thing. Its width can: two parts are twice as wide as one.

const ZWJ = String.fromCharCode(0x200d);
const VS16 = String.fromCharCode(0xfe0f);
const FONT = '24px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
const W = 64;
const H = 32;

/**
 * True when `emoji` renders here as one colour glyph.
 *
 * A FAILURE TO ASK ANSWERS YES — no canvas, a context that throws. An unanswerable question is not
 * evidence the font is missing, and the system font is the right thing to try.
 */
export function canDrawEmoji(emoji: string, doc: Pick<Document, "createElement"> = document): boolean {
  try {
    const canvas = doc.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    if (!g) return true;
    g.font = FONT;
    g.textBaseline = "top";
    const paint = (fill: string): Uint8ClampedArray => {
      g.clearRect(0, 0, W, H);
      g.fillStyle = fill;
      g.fillText(emoji, 0, 0);
      return g.getImageData(0, 0, W, H).data;
    };
    // OFF-PALETTE ON PURPOSE, and listed as such in `test:colour-system`: two probe fills painted on
    // a canvas nobody sees, which must stay pure red and pure blue whatever the palette becomes.
    const red = paint("#ff0000");
    const blue = paint("#0000ff");
    let inked = false;
    for (let i = 0; i < red.length; i++) {
      if (red[i] !== blue[i]) return false;
      if (i % 4 === 3 && red[i] !== 0) inked = true;
    }
    if (!inked) return false;
    const parts = [...emoji].filter((c) => c !== ZWJ && c !== VS16);
    if (parts.length > 1) {
      const one = g.measureText(parts[0]!).width;
      if (one > 0 && g.measureText(emoji).width > one * 1.5) return false;
    }
    return true;
  } catch {
    return true;
  }
}
