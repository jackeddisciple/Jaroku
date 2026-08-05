// A block of a first-run screen, arriving.
//
// §4.6 allows motion that signals a state change and forbids motion that decorates. A screen
// appearing is a state change — it is the largest one the app makes — and the thing worth
// signalling about it is ORDER: mark, then claim, then explanation, then the action. Fading the
// whole screen in at once says nothing; staggering it says what to read first, which is the only
// job a welcome screen has.
//
// One knob, `delay`, because the stagger has to stay legible when somebody adds a block in the
// middle. The steps space themselves in multiples of 60ms at the call site, so the whole sequence
// is over inside half a second — long enough to be a sequence, short enough that a returning user
// pressing Enter never waits on it.
//
// `motion-reduce` drops it to nothing rather than to something faster. Somebody who has asked the
// OS for less movement is not asking for quicker movement.

export function Reveal({
  delay = 0,
  className = "",
  children,
}: {
  /** Milliseconds after mount. Multiples of 60 keep the ladder even. */
  delay?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`animate-rise motion-reduce:animate-none ${className}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}
