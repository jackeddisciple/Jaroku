// A block of code's coloured runs, for a component that lays out its own lines — null until they
// arrive, and null for good when there is no grammar (the caller draws it plain).

import { useEffect, useState } from "react";
import { highlightTokens, type CodeToken } from "./highlight.ts";

export function useCodeTokens(code: string, lang: string | null): CodeToken[][] | null {
  const [tokens, setTokens] = useState<CodeToken[][] | null>(null);
  useEffect(() => {
    setTokens(null);
    if (!lang || !code) return;
    let cancelled = false;
    void highlightTokens(code, lang).then((t) => {
      if (!cancelled) setTokens(t);
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);
  return tokens;
}
