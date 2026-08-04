// The surface steps 1 and 2 sit on.
//
// It reuses App's outer shell — the inset, the rounded border, the one outer shadow — so the
// first two screens read as the same lifted object the app becomes, rather than as a separate
// splash page the product cuts away from. What it does NOT do is mount the three columns
// (see WelcomeStep for why), so this is one div and a scroll container.

export function OnboardingSurface({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full bg-void p-2">
      <div className="flex h-full flex-col overflow-hidden rounded-modal border border-edge bg-bg shadow-overlay">
        {/* Scrolls rather than clips: step 2 grows when a provider card is expanded, and a
            short window must not put the Save button out of reach. */}
        <div className="flex flex-1 min-h-0 items-center justify-center overflow-y-auto px-6 py-10">
          <div className="w-full max-w-[680px]">{children}</div>
        </div>
      </div>
    </div>
  );
}
