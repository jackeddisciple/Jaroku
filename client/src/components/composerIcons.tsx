// What is left of the composer's own icon file: one chevron.
//
// The mic, the send arrow and the save-to-dataset bookmark used to live here as Tabler geometry
// drawn through panelIcons.tsx's factory. They are now §2.1 registry tokens — Icon.Mic, Icon.Send,
// Icon.AttachDataset — because the composer's controls are the one row in the product where two
// icon families sitting side by side is immediately visible, and the registry is where that row's
// glyphs are decided.
//
// THE CHEVRON STAYED, and the distinction is worth naming rather than treating as an oversight.
// The registry holds the composer's CONTROLS: things a user presses to change what is sent or how.
// A disclosure chevron is chrome — it says "this opens" and appears identically in the model
// selector, the MCP section and every tree in the app. Moving it into the registry would have made
// §2.1's table a general icon set, which is the thing that stops it being a small verifiable list.
//
// Sizes come off ICON's ladder, and this one is still Lucide at stroke 1.75 like the chrome around
// it. That is deliberate: it sits inside the model selector's label, next to Lucide type marks,
// not in the bar's row of Hugeicons controls.

import { ICON } from "../lib/tokens.ts";
import { svg } from "./panelIcons.tsx";

type P = { size?: number };

export function ChevronDownIcon({ size = ICON.sm - 1 }: P) {
  return svg({ size }, <path d="M6 9l6 6l6 -6" />);
}
