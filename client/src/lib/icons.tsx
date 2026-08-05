// Brand marks. The design rule (doc §4.2): a brand icon shows its real color only when it's
// the active/chosen/connected thing; otherwise it renders muted grey. These are simple
// geometric marks, not pixel logos — enough to read "Claude" vs "OpenAI" at a glance.

// Stroke weight comes from ICON.strokeWidth like every other icon in the app. These used to be
// drawn at 2 / 1.8 / 2 with their own inline <svg> attributes, so the provider mark in the top
// bar sat visibly heavier than the icons either side of it.
import { ICON } from "./tokens.ts";

const MUTED = "#71717a";

export const BRAND_COLOR: Record<string, string> = {
  anthropic: "#d97757", // Claude terracotta
  openai: "#10a37f", // OpenAI green
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

const PROVIDER_PATH: Record<string, string> = {
  anthropic: CLAUDE_MARK,
  openai: OPENAI_MARK,
};

/** Provider mark for the chip in the top bar / status bar, and the rows on step 2. */
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
 * The real logo, traced from `assets/logo.jpeg` (the source of truth; `assets/logo.svg` is the
 * same three contours as a standalone file). Three curved strokes chasing each other around a
 * circle — the loop the product is about — drawn as three closed shapes on the 24px grid every
 * other icon uses, inset to 22 so it sits at the same optical weight as one.
 *
 * What it replaces was a stand-in: a half-filled triangle, itself standing in for a `◭` character.
 *
 * Two things it does differently from the stand-in.
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
      <path d="M11 1.04C11.6 0.98 12.2 0.97 12.79 1.03C13.38 1.07 13.97 1.18 14.54 1.34C15.12 1.5 15.69 1.7 16.22 1.95C16.76 2.2 17.37 2.46 17.76 2.85C18.13 3.25 18.55 3.85 18.51 4.36C18.48 4.85 17.94 5.4 17.56 5.85C17.19 6.3 16.73 6.7 16.24 7.05C15.77 7.39 15.23 7.66 14.69 7.9C14.15 8.14 13.57 8.32 12.99 8.47C12.42 8.62 11.83 8.7 11.25 8.83C10.66 8.96 10.08 9.07 9.51 9.24C8.94 9.41 8.37 9.62 7.83 9.86C7.29 10.09 6.76 10.37 6.25 10.68C5.75 11 5.26 11.36 4.81 11.74C4.36 12.13 4.01 12.68 3.55 13C3.08 13.31 2.39 13.78 2.02 13.62C1.64 13.48 1.39 12.64 1.3 12.08C1.21 11.53 1.37 10.89 1.47 10.31C1.57 9.73 1.71 9.14 1.9 8.58C2.08 8.01 2.29 7.45 2.57 6.92C2.83 6.39 3.15 5.89 3.49 5.4C3.85 4.92 4.24 4.47 4.67 4.05C5.09 3.64 5.56 3.26 6.05 2.92C6.54 2.59 7.06 2.29 7.59 2.04C8.13 1.78 8.69 1.56 9.26 1.39C9.83 1.23 10.41 1.1 11 1.04Z" />
      <path d="M20.99 7.72C21.31 7.65 21.84 8.21 22.08 8.61C22.33 9.01 22.39 9.63 22.5 10.15C22.6 10.67 22.66 11.2 22.69 11.73C22.71 12.27 22.68 12.8 22.62 13.33C22.57 13.85 22.48 14.38 22.34 14.9C22.21 15.41 22.04 15.91 21.83 16.41C21.62 16.9 21.39 17.38 21.11 17.83C20.85 18.29 20.53 18.73 20.2 19.14C19.86 19.55 19.51 19.96 19.11 20.31C18.73 20.67 18.29 20.99 17.85 21.29C17.41 21.58 16.95 21.86 16.47 22.08C16 22.31 15.49 22.5 14.98 22.65C14.47 22.8 13.92 22.97 13.41 22.96C12.9 22.95 12.31 22.84 11.9 22.57C11.49 22.29 11.08 21.79 10.95 21.32C10.81 20.86 10.88 20.22 11.07 19.77C11.27 19.32 11.72 18.92 12.12 18.59C12.52 18.26 13.05 18.07 13.49 17.78C13.93 17.49 14.38 17.19 14.8 16.85C15.21 16.52 15.6 16.15 15.97 15.78C16.34 15.39 16.68 14.98 17.01 14.57C17.34 14.15 17.66 13.71 17.95 13.27C18.24 12.83 18.53 12.38 18.78 11.91C19.04 11.45 19.29 10.97 19.52 10.49C19.75 10.01 19.91 9.49 20.16 9.03C20.41 8.56 20.67 7.78 20.99 7.72Z" />
      <path d="M10.31 11.35C10.75 11.29 11.21 11.29 11.65 11.3C12.1 11.33 12.56 11.37 12.98 11.51C13.39 11.64 13.88 11.82 14.15 12.13C14.42 12.43 14.61 12.94 14.61 13.35C14.6 13.76 14.36 14.22 14.12 14.59C13.88 14.94 13.5 15.24 13.15 15.51C12.81 15.8 12.4 16.01 12.04 16.25C11.66 16.51 11.29 16.75 10.94 17.02C10.59 17.31 10.24 17.6 9.95 17.94C9.65 18.27 9.37 18.64 9.18 19.04C8.99 19.43 8.87 19.88 8.8 20.32C8.74 20.76 8.9 21.28 8.76 21.66C8.63 22.05 8.33 22.51 7.99 22.64C7.64 22.78 7.09 22.61 6.67 22.46C6.26 22.32 5.86 22.07 5.5 21.81C5.14 21.55 4.81 21.23 4.54 20.88C4.26 20.53 4.03 20.14 3.85 19.73C3.69 19.32 3.56 18.87 3.52 18.43C3.48 18 3.51 17.53 3.59 17.1C3.68 16.66 3.81 16.22 4 15.81C4.17 15.4 4.4 15.01 4.66 14.65C4.91 14.28 5.21 13.93 5.53 13.62C5.84 13.31 6.2 13.03 6.57 12.78C6.94 12.53 7.34 12.33 7.75 12.14C8.16 11.95 8.57 11.77 9 11.64C9.42 11.51 9.86 11.41 10.31 11.35Z" />
    </svg>
  );
}

/** A tiny connector dot — brand color when the agent is wired to it, grey otherwise. */
export function ConnectorDot({ id, active = true }: { id: string; active?: boolean }) {
  const color = active ? BRAND_COLOR[id] ?? MUTED : MUTED;
  return <span className="inline-block w-1.5 h-1.5 rounded-full align-middle" style={{ background: color }} aria-hidden />;
}
