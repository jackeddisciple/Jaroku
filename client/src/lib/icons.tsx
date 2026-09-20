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
 * The platypus, traced from `assets/mono.png` — the mark drawn for the menu bar, which is the one
 * the artwork ships as a single flat colour and therefore the one that survives being handed
 * `currentColor`. Three closed contours on the same 24px grid every other icon uses: the body, the
 * bill, and the eye wound the other way so nonzero fill leaves it a hole rather than a dot.
 *
 * IT IS WIDER THAN IT IS TALL — 24 by 17.4 on that grid, centred — because the animal is. Callers
 * pass one `size` and get a square box with the mark sitting inside it, so a mark set beside a
 * 24px icon reads at the same width and a little shorter, which is what it should do.
 *
 * What it replaces was three curved strokes chasing each other around a circle, traced in turn from
 * a `logo.jpeg` that no longer exists — see the v0.3.16 logo change, which retired both old files.
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
      <path d="M11.99 3.30C12.66 3.32 12.85 3.29 13.46 3.40C13.56 3.42 13.64 3.47 13.73 3.49C13.76 3.50 13.79 3.48 13.82 3.49C14.09 3.57 14.36 3.65 14.62 3.76C15.03 3.93 15.40 4.16 15.74 4.44C15.84 4.52 15.92 4.62 16.02 4.71C16.03 4.71 16.04 4.70 16.05 4.71C16.23 4.90 16.42 5.09 16.58 5.30C16.77 5.55 16.94 5.83 17.11 6.10C17.13 6.14 17.30 6.38 17.25 6.51C17.19 6.68 16.78 6.58 16.76 6.58C16.47 6.60 16.14 6.72 15.89 6.83C15.62 6.95 15.24 7.19 15.01 7.36C14.95 7.40 14.91 7.46 14.85 7.50C14.82 7.53 14.77 7.54 14.74 7.57C14.69 7.60 14.67 7.65 14.62 7.69C14.61 7.70 14.60 7.69 14.59 7.69C14.43 7.84 14.27 7.98 14.12 8.14C14.12 8.14 14.13 8.16 14.12 8.17C14.03 8.28 13.92 8.36 13.83 8.47C13.60 8.76 13.49 8.91 13.37 9.23C13.34 9.30 13.31 9.37 13.30 9.45C13.29 9.57 13.29 9.70 13.30 9.83C13.31 9.96 13.46 10.20 13.52 10.27C13.60 10.37 13.72 10.44 13.81 10.53C13.81 10.54 13.85 10.64 13.80 10.65C13.62 10.70 13.62 10.62 13.44 10.61C12.85 10.59 12.09 10.57 11.69 11.10C11.63 11.18 11.58 11.26 11.54 11.35C11.50 11.43 11.49 11.52 11.47 11.61C11.44 11.90 11.55 12.22 11.73 12.44C11.86 12.61 12.02 12.77 12.17 12.92C12.18 12.93 12.20 12.92 12.21 12.93C12.31 13.02 12.39 13.13 12.49 13.22C12.50 13.23 12.51 13.21 12.52 13.22C12.63 13.32 12.72 13.43 12.82 13.53C12.83 13.54 12.85 13.53 12.86 13.54C13.03 13.71 13.20 13.88 13.36 14.06C13.37 14.07 13.36 14.09 13.37 14.10C13.42 14.15 13.48 14.19 13.53 14.25C13.59 14.32 13.63 14.41 13.68 14.48C13.71 14.50 13.74 14.52 13.76 14.55C14.02 14.92 14.21 15.21 14.37 15.62C14.50 15.93 14.60 16.30 14.65 16.63C14.67 16.76 14.66 16.90 14.67 17.03C14.67 17.04 14.69 17.04 14.69 17.05C14.69 17.23 14.69 17.41 14.67 17.58C14.63 17.99 14.50 18.39 14.29 18.74C14.10 19.06 13.86 19.32 13.57 19.56C13.40 19.71 13.20 19.85 13.00 19.96C12.79 20.09 12.56 20.19 12.33 20.28C12.18 20.34 12.01 20.38 11.85 20.41C11.77 20.42 11.69 20.42 11.61 20.41C11.50 20.39 11.40 20.35 11.31 20.30C11.11 20.18 11.03 19.94 11.01 19.72C11.00 19.59 11.02 19.46 11.01 19.32C11.00 19.15 10.98 18.97 10.95 18.79C10.85 18.26 10.74 17.93 10.49 17.45C10.17 16.85 10.28 17.12 9.96 16.75C9.96 16.74 9.97 16.72 9.96 16.71C9.49 16.25 9.39 16.15 8.78 15.85C8.75 15.83 8.36 15.60 8.22 15.74C8.19 15.77 8.17 15.83 8.20 15.86C8.40 16.14 8.66 16.36 8.87 16.63C9.24 17.11 9.44 17.52 9.67 18.08C9.74 18.27 9.86 18.74 9.88 18.94C9.91 19.36 9.97 19.76 9.83 20.15C9.81 20.21 9.79 20.27 9.75 20.32C9.61 20.52 9.37 20.70 9.11 20.70C6.98 20.73 4.85 20.72 2.72 20.70C2.59 20.70 2.47 20.67 2.34 20.64C2.03 20.57 1.77 20.48 1.50 20.32C0.76 19.90 0.27 19.16 0.08 18.34C0.04 18.13 0.02 17.92 0.00 17.71C-0.01 17.54 -0.02 17.37 0.00 17.20C0.07 16.52 0.17 16.13 0.44 15.49C0.69 14.91 1.00 14.40 1.39 13.89C1.52 13.72 1.69 13.57 1.83 13.40C1.83 13.40 1.82 13.38 1.83 13.37C2.07 13.12 2.32 12.87 2.57 12.63C2.58 12.62 2.59 12.64 2.60 12.63C2.65 12.59 2.69 12.53 2.74 12.49C2.74 12.48 2.76 12.49 2.77 12.48C2.82 12.44 2.85 12.38 2.90 12.34C2.98 12.27 3.07 12.23 3.15 12.17C3.18 12.14 3.20 12.09 3.24 12.07C3.50 11.86 3.77 11.67 4.04 11.48C4.07 11.46 4.11 11.45 4.14 11.43C4.16 11.42 4.16 11.39 4.19 11.37C4.24 11.34 4.30 11.32 4.35 11.28C4.80 10.96 5.06 10.76 5.42 10.36C5.78 9.95 6.04 9.48 6.22 8.97C6.51 8.16 6.31 8.51 6.62 7.45C6.70 7.17 6.80 6.89 6.92 6.62C7.14 6.10 7.41 5.70 7.78 5.26C7.92 5.08 8.10 4.93 8.26 4.77C8.27 4.76 8.29 4.78 8.30 4.77C8.43 4.66 8.55 4.54 8.68 4.44C9.32 3.95 10.09 3.63 10.87 3.45C11.54 3.29 11.36 3.37 11.97 3.32C11.98 3.32 11.98 3.30 11.99 3.30Z" />
      <path d="M17.37 7.25C17.47 7.25 17.57 7.23 17.67 7.25C17.96 7.31 18.13 7.60 18.30 7.80C18.31 7.81 18.30 7.83 18.31 7.84C18.57 8.11 18.73 8.26 19.05 8.45C19.62 8.79 20.08 8.91 20.79 9.12C21.01 9.19 21.23 9.21 21.45 9.27C21.51 9.28 21.56 9.32 21.61 9.33C22.39 9.51 22.44 9.44 23.24 9.73C23.49 9.82 23.74 9.98 23.89 10.20C24.11 10.51 24.02 10.97 23.79 11.24C23.34 11.77 22.68 12.10 22.04 12.34C21.58 12.51 21.23 12.58 20.74 12.67C20.62 12.69 20.51 12.71 20.40 12.71C20.30 12.72 20.20 12.71 20.10 12.71C20.09 12.72 20.09 12.74 20.08 12.74C19.91 12.74 19.74 12.74 19.57 12.74C19.57 12.74 19.57 12.72 19.56 12.71C19.01 12.66 19.21 12.75 18.63 12.59C18.22 12.48 17.73 12.30 17.34 12.13C17.24 12.08 17.14 12.01 17.04 11.96C17.02 11.95 17.00 11.96 16.99 11.96C16.55 11.74 16.13 11.52 15.70 11.28C15.65 11.26 15.62 11.21 15.57 11.18C15.45 11.11 15.32 11.06 15.20 10.99C14.93 10.83 14.72 10.66 14.54 10.40C14.49 10.31 14.44 10.21 14.42 10.10C14.33 9.63 14.60 9.18 14.90 8.85C15.10 8.63 15.31 8.43 15.53 8.24C15.72 8.08 15.92 7.95 16.12 7.82C16.31 7.70 16.49 7.59 16.69 7.50C16.91 7.40 17.13 7.25 17.37 7.25Z" />
      <path d="M13.65 5.76C13.45 5.83 13.33 5.84 13.20 6.01C13.11 6.13 13.02 6.33 13.03 6.48C13.04 6.78 13.22 7.09 13.52 7.19C13.69 7.24 13.78 7.24 13.97 7.21C14.06 7.19 14.15 7.14 14.22 7.08C14.41 6.92 14.54 6.71 14.52 6.46C14.50 6.20 14.41 6.04 14.20 5.89C14.08 5.79 13.82 5.70 13.65 5.76Z" />
    </svg>
  );
}

/** A tiny connector dot — brand color when the agent is wired to it, grey otherwise. */
export function ConnectorDot({ id, active = true }: { id: string; active?: boolean }) {
  const color = active ? BRAND_COLOR[id] ?? MUTED : MUTED;
  return <span className="inline-block w-1.5 h-1.5 rounded-full align-middle" style={{ background: color }} aria-hidden />;
}
