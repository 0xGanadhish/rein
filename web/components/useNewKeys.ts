'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The keys that appeared since the last time `keys` changed, so a list can flag rows that arrived after a refresh.
 * The first set of keys is the baseline and flags nothing.
 */
export function useNewKeys(keys: string[]): Set<string> {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const signature = keys.join('\n');
  useEffect(() => {
    const prev = seen.current;
    seen.current = new Set(keys);
    if (prev) setFresh(new Set(keys.filter((k) => !prev.has(k))));
    // `signature` stands for `keys`: the array is rebuilt on every render.
  }, [signature]);
  return fresh;
}
