'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The keys that appeared since the last time `keys` changed, so a list can flag rows that arrived after a refresh.
 * The first loaded list is the baseline and flags nothing: pass `loaded` false until the list has loaded, and a new
 * `scope` (say, a different account) to start a fresh baseline.
 */
export function useNewKeys(keys: string[], loaded = true, scope = ''): Set<string> {
  const seen = useRef<Set<string> | null>(null);
  const seenScope = useRef(scope);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const signature = keys.join('\n');
  useEffect(() => {
    if (seenScope.current !== scope) {
      seenScope.current = scope;
      seen.current = null;
      setFresh(new Set());
    }
    if (!loaded) {
      seen.current = null;
      return;
    }
    const prev = seen.current;
    seen.current = new Set(keys);
    if (prev) setFresh(new Set(keys.filter((k) => !prev.has(k))));
    // `signature` stands for `keys`: the array is rebuilt on every render.
  }, [signature, loaded, scope]);
  return fresh;
}
