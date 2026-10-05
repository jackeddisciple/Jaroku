// A clock a component can read, so a relative time it shows keeps moving.
//
// WHY THIS EXISTS. "last job 7s ago" on a fleet card and "2m ago" on a row are computed when they
// render, and they rendered only when their data changed — so a card said "7s ago" about a job
// three minutes old, and a quiet list's times stood still until something unrelated moved it.
// Reading this re-renders the component every `everyMs`, which is what makes the words true again.
//
// ONE INTERVAL PER COMPONENT THAT ASKS, and the components that ask are the list and the strip, not
// each row or card — they pass the moment down by re-rendering their children.

import { useEffect, useState } from "react";

export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}
