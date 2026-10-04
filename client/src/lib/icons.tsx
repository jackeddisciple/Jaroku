// Brand marks. The design rule (doc §4.2): a brand icon shows its real color only when it's
// the active/chosen/connected thing; otherwise it renders muted grey. These are simple
// geometric marks, not pixel logos — enough to read "Claude" vs "OpenAI" at a glance.

// Stroke weight comes from ICON.strokeWidth like every other icon in the app. These used to be
// drawn at 2 / 1.8 / 2 with their own inline <svg> attributes, so the provider mark in the top
// bar sat visibly heavier than the icons either side of it.
import { ICON, TEXT } from "./tokens.ts";

// The grey a brand mark falls back to when it is not the active/chosen/connected thing. §02's
// supporting-text step, so an unbranded provider row reads at the same weight as the words beside
// it — it was a hex copy of the old palette's `muted`, which stayed dark when the palette did not.
const MUTED = TEXT.muted;

export const BRAND_COLOR: Record<string, string> = {
  anthropic: "#d97757", // Claude terracotta
  openai: "#10a37f", // OpenAI green
  // Meta blue, from simple-icons' own record of the brand. A provider with no colour here falls
  // through to MUTED and sits unbranded between two branded rows, reading as one the product only
  // half-supports — which is how Gemini's row looked until its colour was added.
  meta: "#0467DF",
  fake: MUTED,
  gmail: "#ea4335",
  slack: "#e01e5a",
  postgres: "#336791",
};

// The real marks, not approximations of them.
//
// These were hand-drawn stand-ins: eight equal strokes radiating from a dot for Claude, and a
// circle with a crosshair through it for OpenAI. Both were legible as "some provider" and
// neither was legible as WHICH — which is the one job a provider mark has when it is sitting
// directly above a second provider's.
//
// Paths are the official single-colour marks from simple-icons (CC0), on the same 24px grid as
// every other icon here. Filled rather than stroked, because that is how the marks are drawn:
// running them through the icon set's stroke ladder would be redrawing them badly again.
const CLAUDE_MARK =
  "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z";

const OPENAI_MARK =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";

// Meta's mark, the same single-colour simple-icons path (CC0) on the same 24px grid as the two above.
const META_MARK =
  "M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z";

const PROVIDER_PATH: Record<string, string> = {
  anthropic: CLAUDE_MARK,
  openai: OPENAI_MARK,
  meta: META_MARK,
};

/** Provider mark for the rows in the provider-keys dialog and on step 2. */
export function ProviderMark({ provider, active = true, size = 12 }: { provider: string; active?: boolean; size?: number }) {
  const color = active ? BRAND_COLOR[provider] ?? MUTED : MUTED;
  const path = PROVIDER_PATH[provider];
  if (path) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill={color}>
        <path d={path} />
      </svg>
    );
  }
  // fake / unknown: a hollow dot, drawn to the icon set's own stroke rules — there is no brand
  // behind it to be faithful to.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden
      fill="none"
      stroke={color}
      strokeWidth={ICON.strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="6" />
    </svg>
  );
}

/**
 * The Jaroku mark.
 *
 * The portrait, traced from `assets/thenewlogo.png` — its ink alone: the hat's outline, the hair,
 * the profile, the eye and the brow. The halftone is left out on purpose. Its dots are four or five
 * pixels across in a 1287px drawing, so at the sizes this is drawn they would print as a grey smudge
 * over the face; without them the drawing is one flat colour, which is what survives being handed
 * `currentColor`. One compound path on the same 24px grid every other icon uses, the hat's crown
 * wound the other way so nonzero fill leaves it open rather than solid.
 *
 * IT IS A LITTLE WIDER THAN IT IS TALL — 24 by 22.5 on that grid, centred — because the drawing
 * is. Callers pass one `size` and get a square box with the mark sitting inside it, so a mark set
 * beside a 24px icon reads at the same width and a touch shorter, which is what it should do.
 *
 * What it replaces was a platypus traced from a `mono.png`, and before that three curved strokes
 * traced from a `logo.jpeg`; neither file is in `assets/` any more.
 *
 * Two things it does differently from an icon.
 *
 * Solid fills, no stroke. A mark is not an icon — the stroke ladder governs the icon set, and a
 * logo drawn to the same rules as a chevron reads as neither.
 *
 * `currentColor` by default, rather than amber. Amber is `run` — it means an agent is executing —
 * and doc §4.2's rule is that color carries meaning and nothing else. A brand mark permanently
 * wearing the running color spends the one thing the status palette cannot afford to spend, and
 * on a screen where a real running badge is inches away it is the wrong kind of twice-look. The
 * mark inherits the ink of whatever it sits in; callers that need a specific tone pass `color`.
 */
export function JarokuGlyph({ size = 15, color }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill={color ?? "currentColor"}>
      <path d="M16.36 23.14C16.36 22.77 16.64 21.62 16.92 20.84C17.08 20.39 17.20 20.06 17.22 20.03C17.23 20.01 17.26 19.95 17.29 19.88C17.44 19.57 17.64 19.19 17.71 19.08C17.81 18.93 17.85 18.92 18.12 18.98C18.80 19.14 19.04 19.19 19.18 19.21C19.27 19.22 19.41 19.25 19.51 19.27C20.04 19.37 21.08 19.40 21.42 19.32C22.13 19.15 22.46 18.66 22.36 17.94C22.27 17.30 22.32 17.08 22.63 16.70C22.76 16.54 22.77 16.52 22.72 16.42C22.68 16.36 22.66 16.35 22.49 16.32C22.20 16.28 22.07 16.20 22.07 16.06C22.07 15.94 22.14 15.87 22.28 15.84C22.83 15.70 22.99 15.53 22.81 15.24C22.59 14.90 22.53 14.64 22.60 14.44C22.64 14.35 22.67 14.32 22.87 14.18C23.15 14.00 23.32 13.84 23.40 13.68C23.50 13.47 23.51 13.49 22.99 12.94C22.27 12.19 22.00 11.78 21.74 11.06C21.70 10.93 21.65 10.82 21.64 10.82C21.63 10.82 21.62 10.79 21.62 10.76C21.62 10.69 21.50 10.25 21.46 10.15C21.45 10.13 21.43 10.04 21.41 9.97C21.35 9.66 21.08 8.72 21.02 8.60C21.00 8.57 20.98 8.49 20.96 8.44C20.92 8.29 20.68 7.79 20.60 7.69C20.56 7.64 20.53 7.59 20.53 7.59C20.53 7.58 20.50 7.52 20.46 7.46L20.39 7.35L20.25 7.61C20.07 7.96 19.94 8.19 19.81 8.36C19.76 8.44 19.71 8.52 19.71 8.54C19.71 8.56 19.70 8.58 19.68 8.59C19.66 8.60 19.55 8.74 19.42 8.89C19.16 9.23 18.66 9.75 18.33 10.03C18.21 10.14 18.10 10.25 18.10 10.27C18.10 10.28 18.08 10.30 18.06 10.30C18.03 10.30 17.65 10.56 17.38 10.76C17.34 10.80 17.30 10.82 17.29 10.82C17.28 10.82 17.23 10.85 17.18 10.88C17.06 10.97 16.77 11.13 16.50 11.27C16.37 11.34 16.26 11.40 16.26 11.41C16.26 11.42 16.24 11.43 16.22 11.43C16.16 11.43 15.68 11.63 15.63 11.67C15.61 11.69 15.57 11.71 15.55 11.71C15.41 11.71 15.22 11.90 15.18 12.07C15.18 12.11 15.16 12.14 15.14 12.14C15.04 12.18 14.94 12.77 14.97 13.10C15.01 13.51 15.32 14.20 15.60 14.51C15.62 14.53 15.67 14.60 15.71 14.65C15.74 14.70 15.79 14.74 15.80 14.74C15.82 14.74 15.83 14.76 15.83 14.78C15.83 14.80 15.88 14.87 15.94 14.94C16.19 15.25 16.47 15.65 16.67 16.02C16.74 16.14 16.87 16.61 16.91 16.87C16.97 17.20 16.92 17.80 16.82 18.02C16.80 18.06 16.78 18.12 16.77 18.15C16.63 18.62 16.09 19.28 15.85 19.28C15.74 19.28 15.74 19.23 15.86 18.87C16.12 18.06 16.07 17.25 15.71 16.63C15.63 16.51 15.63 16.52 15.67 16.68C16.03 18.22 15.36 19.86 13.99 20.77C13.86 20.86 13.75 20.94 13.74 20.95C13.73 20.97 13.71 20.98 13.69 20.98C13.68 20.98 13.58 21.02 13.47 21.07C13.36 21.12 13.19 21.19 13.08 21.23C12.96 21.27 12.85 21.31 12.83 21.32C12.67 21.39 11.99 21.48 11.66 21.48C11.41 21.48 11.42 21.48 11.26 21.69C11.07 21.93 10.73 22.24 10.45 22.44C10.05 22.71 9.32 22.93 8.82 22.93C8.65 22.93 8.67 22.86 8.88 22.57C9.08 22.28 9.23 22.03 9.34 21.77C9.45 21.50 9.44 21.48 9.24 21.61C8.37 22.18 7.29 22.39 6.19 22.21C5.50 22.09 5.00 21.83 4.84 21.49C4.73 21.27 4.78 20.96 4.96 20.72L5.05 20.60L4.79 20.72C4.32 20.92 4.05 20.99 3.70 21.02C2.76 21.10 2.03 20.45 2.07 19.57C2.10 18.98 2.44 18.41 3.28 17.56C3.49 17.35 3.65 17.17 3.65 17.17C3.64 17.17 3.51 17.23 3.37 17.31C2.17 17.90 1.24 18.05 0.62 17.74C0.02 17.44 -0.16 16.86 0.16 16.21C0.46 15.58 1.18 14.95 2.33 14.31C2.90 13.99 3.32 13.61 3.61 13.18C3.72 13.01 3.85 12.71 3.87 12.58C3.89 12.49 3.90 12.50 3.57 12.45C2.98 12.37 2.19 12.06 1.69 11.72C1.28 11.44 0.84 10.93 0.68 10.56C0.60 10.37 0.60 10.01 0.67 9.82C0.79 9.53 1.25 9.04 2.02 8.37C2.52 7.94 2.95 7.54 3.13 7.35C3.47 7.00 3.81 6.62 4.01 6.37C5.44 4.68 6.21 3.91 7.28 3.10C10.23 0.89 13.61 0.21 16.65 1.22C17.91 1.64 18.91 2.31 19.79 3.31C19.87 3.40 19.88 3.40 19.99 3.40C20.46 3.40 21.07 3.63 21.52 3.97C21.98 4.31 22.56 4.99 22.81 5.49C23.33 6.52 22.96 7.74 21.85 8.58L21.72 8.69L21.79 8.95C21.84 9.10 21.92 9.44 21.98 9.71C22.17 10.52 22.21 10.69 22.29 10.92C22.49 11.50 22.76 11.89 23.45 12.62C23.94 13.13 24.00 13.23 24.00 13.53C24.00 13.87 23.73 14.26 23.30 14.55C23.11 14.68 23.11 14.68 23.26 14.95C23.49 15.35 23.48 15.66 23.22 15.93L23.12 16.04L23.20 16.15C23.37 16.41 23.32 16.70 23.08 16.99C22.88 17.23 22.84 17.44 22.91 17.88C23.07 18.86 22.50 19.66 21.49 19.88C21.14 19.95 20.28 19.95 19.80 19.88C19.72 19.87 19.72 19.87 19.69 19.97C19.64 20.13 19.65 20.51 19.71 20.72C19.84 21.19 20.19 21.66 20.57 21.89C20.72 21.98 20.73 21.99 20.73 22.06C20.73 22.15 20.70 22.16 20.40 22.26C19.46 22.57 18.10 22.63 17.27 22.40C17.16 22.37 17.06 22.35 17.06 22.36C17.04 22.38 16.96 22.80 16.92 23.05L16.89 23.25L16.62 23.25L16.36 23.25L16.36 23.14ZM6.97 13.02C8.54 11.57 10.16 10.28 12.22 8.88C16.29 6.08 20.02 4.70 21.85 5.30C21.94 5.32 22.02 5.35 22.02 5.34C22.04 5.32 21.71 4.92 21.51 4.72C20.93 4.13 20.20 3.86 19.25 3.86L18.96 3.86L18.96 3.78C18.96 3.70 18.97 3.69 19.10 3.64C19.18 3.60 19.24 3.57 19.24 3.56C19.24 3.55 19.08 3.39 18.89 3.21C18.39 2.72 18.05 2.47 17.44 2.17C14.99 0.94 11.89 1.08 9.18 2.54C7.55 3.42 6.38 4.44 4.71 6.42C3.83 7.46 3.34 7.96 2.40 8.78C1.55 9.53 1.18 9.94 1.18 10.14C1.18 10.45 1.58 10.95 2.09 11.29C2.58 11.62 3.35 11.88 3.89 11.91L3.99 11.92L4.06 11.72C4.24 11.18 4.58 10.75 5.04 10.48C5.14 10.42 5.21 10.39 5.27 10.39C5.35 10.39 5.35 10.39 5.35 10.48C5.35 10.56 5.34 10.58 5.30 10.59C5.27 10.60 5.23 10.64 5.21 10.67C5.02 10.93 4.87 11.21 4.83 11.36C4.74 11.73 4.74 11.74 4.75 12.06C4.75 12.34 4.76 12.40 4.83 12.58C5.00 13.10 5.36 13.66 5.72 13.97L5.86 14.09L6.31 13.66C6.55 13.42 6.85 13.13 6.97 13.02ZM19.78 12.55C19.35 12.41 19.23 11.83 19.57 11.51L19.70 11.40L19.90 11.40C20.11 11.40 20.11 11.40 20.21 11.48C20.49 11.70 20.51 12.19 20.23 12.44C20.11 12.55 19.94 12.59 19.78 12.55ZM18.45 10.90C18.41 10.87 18.40 10.84 18.40 10.75C18.40 10.65 18.41 10.63 18.53 10.48C18.69 10.27 18.86 10.12 19.07 9.99C19.15 9.93 19.23 9.88 19.23 9.86C19.24 9.85 19.25 9.84 19.27 9.84C19.29 9.84 19.39 9.81 19.51 9.78C19.91 9.65 20.14 9.69 20.14 9.91C20.14 10.07 20.14 10.08 19.90 10.15C19.50 10.26 19.22 10.42 18.86 10.75C18.63 10.95 18.56 10.98 18.45 10.90Z" />
    </svg>
  );
}

/** A tiny connector dot — brand color when the agent is wired to it, grey otherwise. */
export function ConnectorDot({ id, active = true }: { id: string; active?: boolean }) {
  const color = active ? BRAND_COLOR[id] ?? MUTED : MUTED;
  return <span className="inline-block w-1.5 h-1.5 rounded-full align-middle" style={{ background: color }} aria-hidden />;
}
