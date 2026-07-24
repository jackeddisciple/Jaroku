// Inline SVGs styled after Tabler (ti-microphone / ti-arrow-up / ti-chevron-down). Stroke uses
// currentColor so the parent controls colour; no icon dependency (same idiom as graphIcons.tsx).

type P = { size?: number };

const svg = (size: number, children: React.ReactNode) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {children}
  </svg>
);

export function MicIcon({ size = 17 }: P) {
  return svg(
    size,
    <>
      <path d="M9 5a3 3 0 0 1 6 0v5a3 3 0 0 1 -6 0z" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
    </>,
  );
}

export function ArrowUpIcon({ size = 15 }: P) {
  return svg(
    size,
    <>
      <path d="M12 5v14" />
      <path d="M18 11l-6 -6" />
      <path d="M6 11l6 -6" />
    </>,
  );
}

export function ChevronDownIcon({ size = 13 }: P) {
  return svg(size, <path d="M6 9l6 6l6 -6" />);
}
