// The Inbox's fifteen type marks, as inline SVG at the app's one stroke weight.
//
// SOURCED FROM THE HUGEICONS FREE SET (https://hugeicons.com/icons) and COMMITTED HERE, which §7
// asks for in both halves: an icon font loaded at runtime is a network dependency for a glyph, and
// hotlinking is somebody else's uptime deciding whether a card has a mark on it.
//
// EVERY STROKE WIDTH AND COLOUR THE SOURCE CARRIED IS DROPPED. v0.2.2 replaced eighteen font
// characters standing in for icons with real SVGs at ONE weight, and the fastest way to undo that
// pass is to paste a set drawn at a different one — HugeIcons ships at 1.5 on a 24 grid and this app
// draws at ICON.strokeWidth. The shared `svg()` helper in panelIcons.tsx supplies both, so every mark
// in this file is optically the same weight as every mark two panels over, and every one of them
// inherits `currentColor` so a card can tint it.
//
// ONE ICON PER ITEM TYPE, AND THE REGISTRY IS WHAT SAYS WHICH. The server sends an icon NAME on the
// wire; `INBOX_ICON` below is the one lookup that turns it into a drawing. A name with no entry is a
// compile error here rather than a blank square in a column, which is the whole reason the map is
// exhaustive over the union rather than a `Record<string, ...>`.
//
// WHAT IS DELIBERATELY NOT HERE: an icon for an ACTION. §7 says not to define a second icon for an
// action that already has one — resolve, retry, view logs, deploy and rediscover all exist in
// `lib/actionIcons.tsx` and `panelIcons.tsx` — so this file is item TYPES only, which is the one
// vocabulary the app did not already have.

import { svg } from "./panelIcons.tsx";
import type { InboxIconName } from "../types.ts";

type P = { size?: number; className?: string };


/** `credential_missing / setup_api_key` — HugeIcons `key-01`, redrawn at this app's stroke weight. */
export function KeyIcon2(p: P) {
  return svg(
    p,
    <>
      <path d="M15.5 14.5C18.8137 14.5 21.5 11.8137 21.5 8.5C21.5 5.18629 18.8137 2.5 15.5 2.5C12.1863 2.5 9.5 5.18629 9.5 8.5C9.5 9.38041 9.68962 10.2165 10.0303 10.9697L2.5 18.5V21.5H5.5V19.5H7.5V17.5H9.5L13.0303 13.9697C13.7835 14.3104 14.6196 14.5 15.5 14.5Z" />
      <path d="M17.5 6.5L16.5 7.5" />
    </>,
  );
}

/** `mcp_auth_required` — HugeIcons `plug-01`, redrawn at this app's stroke weight. */
export function PlugIcon2(p: P) {
  return svg(
    p,
    <>
      <path d="M15.5 2V6M8.5 6V2" />
      <path d="M6.00446 7.61331C5.93719 6.74273 6.63957 6 7.53014 6H16.4699C17.3604 6 18.0628 6.74273 17.9955 7.61331L17.8117 9.99197C17.6796 11.7019 17.1011 13.3498 16.132 14.7773L15.5312 15.6622C14.9638 16.4979 14.0077 17 12.9838 17H11.0162C9.99228 17 9.03617 16.4979 8.46881 15.6622L7.86803 14.7773C6.89885 13.3498 6.32041 11.7019 6.18827 9.99197L6.00446 7.61331Z" />
      <path d="M12 17V22" />
      <path d="M11 9H13" />
    </>,
  );
}

/** `deploy_failed` — HugeIcons `rocket-01`, redrawn at this app's stroke weight. */
export function RocketIcon2(p: P) {
  return svg(
    p,
    <>
      <path d="M11.8013 6.48949L13.2869 5.00392C14.9596 3.3312 17.1495 2.63737 19.4671 2.52399C20.3686 2.47989 20.8193 2.45784 21.1807 2.81928C21.5422 3.18071 21.5201 3.63143 21.476 4.53289C21.3626 6.8505 20.6688 9.04042 18.9961 10.7131L17.5105 12.1987C16.2871 13.4221 15.9393 13.77 16.1961 15.097C16.4496 16.1107 16.6949 17.0923 15.9578 17.8294C15.0637 18.7235 14.2481 18.7235 13.354 17.8294L6.17058 10.646C5.27649 9.75188 5.27646 8.9363 6.17058 8.04219C6.90767 7.30509 7.88929 7.55044 8.90297 7.80389C10.23 8.06073 10.5779 7.71289 11.8013 6.48949Z" />
      <path d="M16.9959 7H17.0049" />
      <path d="M2.5 21.5L7.5 16.5" />
      <path d="M8.5 21.5L10.5 19.5" />
      <path d="M2.5 15.5L4.5 13.5" />
    </>,
  );
}

/** `budget_ceiling_hit` — HugeIcons `wallet-01`, redrawn at this app's stroke weight. */
export function WalletIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M14 3H5C3.89543 3 3 3.89543 3 5C3 6.10457 3.89543 7 5 7H18C18 6.07003 18 5.60504 17.8978 5.22354C17.6204 4.18827 16.8117 3.37962 15.7765 3.10222C15.395 3 14.93 3 14 3Z" />
      <path d="M3 5V15C3 17.8284 3 19.2426 3.87868 20.1213C4.75736 21 6.17157 21 9 21H15C17.8284 21 19.2426 21 20.1213 20.1213C21 19.2426 21 17.8284 21 15V13C21 10.1716 21 8.75736 20.1213 7.87868C19.2426 7 17.8284 7 15 7H7" />
      <path d="M21 12H19C18.535 12 18.3025 12 18.1118 12.0511C17.5941 12.1898 17.1898 12.5941 17.0511 13.1118C17 13.3025 17 13.535 17 14C17 14.465 17 14.6975 17.0511 14.8882C17.1898 15.4059 17.5941 15.8102 18.1118 15.9489C18.3025 16 18.535 16 19 16H21" />
    </>,
  );
}

/** `unreviewed_failures` — HugeIcons `alert-02`, redrawn at this app's stroke weight. */
export function AlertIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M5.32171 9.6829C7.73539 5.41196 8.94222 3.27648 10.5983 2.72678C11.5093 2.42437 12.4907 2.42437 13.4017 2.72678C15.0578 3.27648 16.2646 5.41196 18.6783 9.6829C21.092 13.9538 22.2988 16.0893 21.9368 17.8293C21.7376 18.7866 21.2469 19.6548 20.535 20.3097C19.241 21.5 16.8274 21.5 12 21.5C7.17265 21.5 4.75897 21.5 3.46496 20.3097C2.75308 19.6548 2.26239 18.7866 2.06322 17.8293C1.70119 16.0893 2.90803 13.9538 5.32171 9.6829Z" />
      <path d="M11.992 16H12.001" />
      <path d="M12 13L12 8.99997" />
    </>,
  );
}

/** `version_drift` — HugeIcons `arrow-data-transfer-horizontal`, redrawn at this app's stroke weight. */
export function DriftIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M19 9H6.65856C5.65277 9 5.14987 9 5.02472 8.69134C4.89957 8.38268 5.25517 8.01942 5.96637 7.29289L8.21091 5" />
      <path d="M5 15H17.3414C18.3472 15 18.8501 15 18.9753 15.3087C19.1004 15.6173 18.7448 15.9806 18.0336 16.7071L15.7891 19" />
    </>,
  );
}

/** `eval_finished` — HugeIcons `test-tube-01`, redrawn at this app's stroke weight. */
export function FlaskIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M14.5405 2V4.48622C14.5405 6.23417 14.5405 7.10814 14.7545 7.94715C14.9685 8.78616 15.3879 9.55654 16.2267 11.0973L17.3633 13.1852C19.5008 17.1115 20.5696 19.0747 19.6928 20.53L19.6792 20.5522C18.7896 22 16.5264 22 12 22C7.47357 22 5.21036 22 4.3208 20.5522L4.30725 20.53C3.43045 19.0747 4.49918 17.1115 6.63666 13.1852L7.7733 11.0973C8.61209 9.55654 9.03149 8.78616 9.24548 7.94715C9.45947 7.10814 9.45947 6.23417 9.45947 4.48622V2" />
      <path d="M9 16.002L9.00868 15.9996" />
      <path d="M15 18.002L15.0087 17.9996" />
      <path d="M8 2L16 2" />
      <path d="M7.5 11.5563C8.5 10.4029 10.0994 11.2343 12 12.3182C14.5 13.7439 16 12.65 16.5 11.6152" />
    </>,
  );
}

/** `mcp_unreachable` — HugeIcons `unlink-01`, redrawn at this app's stroke weight. */
export function UnpluggedIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M12.1434 10.691L12.3503 10.4841C14.329 8.50532 17.5372 8.50532 19.5159 10.4841C21.4947 12.4628 21.4947 15.671 19.5159 17.6497L16.6497 20.5159C14.671 22.4947 11.4628 22.4947 9.48405 20.5159C7.50532 18.5372 7.50532 15.329 9.48405 13.3503L9.9484 12.886" />
      <path d="M20.0516 11.114L20.5159 10.6497C22.4947 8.67095 22.4947 5.46279 20.5159 3.48405C18.5372 1.50532 15.329 1.50532 13.3503 3.48405L10.4841 6.35031C8.50532 8.32904 8.50532 11.5372 10.4841 13.5159C12.4628 15.4947 15.671 15.4947 17.6497 13.5159L17.8566 13.309" />
      <path d="M4.5 4L6 6M2 8L5 9M3 13.5L5 12" />
    </>,
  );
}

/** `cost_anomaly` — HugeIcons `chart-increase`, redrawn at this app's stroke weight. */
export function SpikeIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M21 21H10C6.70017 21 5.05025 21 4.02513 19.9749C3 18.9497 3 17.2998 3 14V3" />
      <path d="M7.99707 16.999C11.5286 16.999 18.9122 15.5348 18.6979 6.43269M16.4886 8.04302L18.3721 6.14612C18.5656 5.95127 18.8798 5.94981 19.0751 6.14286L20.9971 8.04302" />
    </>,
  );
}

/** `memory_proposal` — HugeIcons `brain-02`, redrawn at this app's stroke weight. */
export function MemoryIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M4.22222 21.9948V18.4451C4.22222 17.1737 3.88927 16.5128 3.23482 15.4078C2.4503 14.0833 2 12.5375 2 10.8866C2 5.97866 5.97969 2 10.8889 2C15.7981 2 19.7778 5.97866 19.7778 10.8866C19.7778 11.4663 19.7778 11.7562 19.802 11.9187C19.8598 12.3072 20.0411 12.6414 20.2194 12.9873L22 16.4407L20.6006 17.1402C20.195 17.3429 19.9923 17.4443 19.851 17.6314C19.7097 17.8184 19.67 18.0296 19.5904 18.4519L19.5826 18.4931C19.4004 19.4606 19.1993 20.5286 18.6329 21.2024C18.4329 21.4403 18.1853 21.6336 17.9059 21.7699C17.4447 21.9948 16.8777 21.9948 15.7437 21.9948C15.219 21.9948 14.6928 22.0069 14.1682 21.9942C12.9247 21.9639 12 20.9184 12 19.7044" />
      <path d="M14.388 10.5315C13.9617 10.5315 13.5729 10.3702 13.2784 10.1048M14.388 10.5315C14.388 11.6774 13.7241 12.7658 12.4461 12.7658C11.1681 12.7658 10.5043 13.8541 10.5043 15M14.388 10.5315C16.5373 10.5315 16.5373 7.18017 14.388 7.18017C14.1927 7.18017 14.0053 7.21403 13.8312 7.27624C13.9362 4.77819 10.3349 4.1 9.51923 6.44018M10.5043 8.29729C10.5043 7.52323 10.1133 6.8411 9.51923 6.44018M9.51923 6.44018C7.66742 5.19034 5.19883 7.4331 6.37324 9.43277C4.40226 9.72827 4.61299 12.7658 6.6205 12.7658C7.18344 12.7658 7.68111 12.4844 7.98234 12.0538" />
    </>,
  );
}

/** `ungated_high_impact` — HugeIcons `shield-01`, redrawn at this app's stroke weight. */
export function ShieldIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M21 11.1833V8.28029C21 6.64029 21 5.82028 20.5959 5.28529C20.1918 4.75029 19.2781 4.49056 17.4507 3.9711C16.2022 3.6162 15.1016 3.18863 14.2223 2.79829C13.0234 2.2661 12.424 2 12 2C11.576 2 10.9766 2.2661 9.77771 2.79829C8.89839 3.18863 7.79784 3.61619 6.54933 3.9711C4.72193 4.49056 3.80822 4.75029 3.40411 5.28529C3 5.82028 3 6.64029 3 8.28029V11.1833C3 16.8085 8.06277 20.1835 10.594 21.5194C11.2011 21.8398 11.5046 22 12 22C12.4954 22 12.7989 21.8398 13.406 21.5194C15.9372 20.1835 21 16.8085 21 11.1833Z" />
    </>,
  );
}

/** `invite_pending` — HugeIcons `mail-send-01`, redrawn at this app's stroke weight. */
export function InviteIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M22 12.5001C22 12.0087 21.9947 11.0172 21.9842 10.5244C21.9189 7.45886 21.8862 5.92609 20.7551 4.79066C19.6239 3.65523 18.0497 3.61568 14.9012 3.53657C12.9607 3.48781 11.0393 3.48781 9.09882 3.53656C5.95033 3.61566 4.37608 3.65521 3.24495 4.79065C2.11382 5.92608 2.08114 7.45885 2.01576 10.5244C1.99474 11.5101 1.99475 12.4899 2.01577 13.4756C2.08114 16.5412 2.11383 18.0739 3.24496 19.2094C4.37608 20.3448 5.95033 20.3843 9.09883 20.4634C9.90159 20.4836 10.7011 20.4954 11.5 20.4989" />
      <path d="M2 6L8.91302 9.92462C11.4387 11.3585 12.5613 11.3585 15.087 9.92462L22 6" />
      <path d="M22 17.5L14 17.5M22 17.5C22 16.7998 20.0057 15.4915 19.5 15M22 17.5C22 18.2002 20.0057 19.5085 19.5 20" />
    </>,
  );
}

/** `member_joined` — HugeIcons `user-add-01`, redrawn at this app's stroke weight. */
export function PersonIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M15 8C15 5.23858 12.7614 3 10 3C7.23858 3 5 5.23858 5 8C5 10.7614 7.23858 13 10 13C12.7614 13 15 10.7614 15 8Z" />
      <path d="M17.5 21L17.5 14M14 17.5H21" />
      <path d="M3 20C3 16.134 6.13401 13 10 13C11.4872 13 12.8662 13.4638 14 14.2547" />
    </>,
  );
}

/** `agent_deleted_by_other` — HugeIcons `delete-02`, redrawn at this app's stroke weight. */
export function TrashIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M19.5 5.5L18.8803 15.5251C18.7219 18.0864 18.6428 19.3671 18.0008 20.2879C17.6833 20.7431 17.2747 21.1273 16.8007 21.416C15.8421 22 14.559 22 11.9927 22C9.42312 22 8.1383 22 7.17905 21.4149C6.7048 21.1257 6.296 20.7408 5.97868 20.2848C5.33688 19.3626 5.25945 18.0801 5.10461 15.5152L4.5 5.5" />
      <path d="M3 5.5H21M16.0557 5.5L15.3731 4.09173C14.9196 3.15626 14.6928 2.68852 14.3017 2.39681C14.215 2.3321 14.1231 2.27454 14.027 2.2247C13.5939 2 13.0741 2 12.0345 2C10.9688 2 10.436 2 9.99568 2.23412C9.8981 2.28601 9.80498 2.3459 9.71729 2.41317C9.32164 2.7167 9.10063 3.20155 8.65861 4.17126L8.05292 5.5" />
      <path d="M9.5 16.5L9.5 10.5" />
      <path d="M14.5 16.5L14.5 10.5" />
    </>,
  );
}

/** `setup_first_agent` — HugeIcons `sparkles`, redrawn at this app's stroke weight. */
export function SparkIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M15 2L15.5387 4.39157C15.9957 6.42015 17.5798 8.00431 19.6084 8.46127L22 9L19.6084 9.53873C17.5798 9.99569 15.9957 11.5798 15.5387 13.6084L15 16L14.4613 13.6084C14.0043 11.5798 12.4202 9.99569 10.3916 9.53873L8 9L10.3916 8.46127C12.4201 8.00431 14.0043 6.42015 14.4613 4.39158L15 2Z" />
      <path d="M7 12L7.38481 13.7083C7.71121 15.1572 8.84275 16.2888 10.2917 16.6152L12 17L10.2917 17.3848C8.84275 17.7112 7.71121 18.8427 7.38481 20.2917L7 22L6.61519 20.2917C6.28879 18.8427 5.15725 17.7112 3.70827 17.3848L2 17L3.70827 16.6152C5.15725 16.2888 6.28879 15.1573 6.61519 13.7083L7 12Z" />
    </>,
  );
}

/**
 * Icon name on the wire → the one drawing for it.
 *
 * EXHAUSTIVE OVER THE UNION the server sends, so a sixteenth item type whose registry entry
 * names an icon nothing has drawn does not compile. A `Record<string, ...>` would accept it and
 * render a hole in a column.
 */
export const INBOX_ICON = {
  key: KeyIcon2,
  plug: PlugIcon2,
  rocket: RocketIcon2,
  wallet: WalletIcon,
  alert: AlertIcon,
  drift: DriftIcon,
  flask: FlaskIcon,
  unplugged: UnpluggedIcon,
  spike: SpikeIcon,
  memory: MemoryIcon,
  shield: ShieldIcon,
  invite: InviteIcon,
  person: PersonIcon,
  trash: TrashIcon,
  spark: SparkIcon,
} as const satisfies Record<InboxIconName, (p: P) => React.ReactElement>;
