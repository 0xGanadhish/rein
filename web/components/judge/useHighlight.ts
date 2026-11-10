'use client';

import { useLayoutEffect, useRef, useState } from 'react';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Measures the selected option inside a group so a highlight can slide to it. Returns the group's ref, the box
 * to draw, and whether the highlight may animate yet (not on its first placement).
 */
export function useHighlight<T extends HTMLElement>(selected: unknown) {
  const ref = useRef<T>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [armed, setArmed] = useState(false);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const measure = () => {
      const el = root.querySelector<HTMLElement>('[aria-checked="true"], [aria-pressed="true"]');
      setBox(el ? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight } : null);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [selected]);

  useLayoutEffect(() => {
    if (box && !armed) {
      const id = requestAnimationFrame(() => setArmed(true));
      return () => cancelAnimationFrame(id);
    }
  }, [box, armed]);

  const style = box ? { width: box.w, height: box.h, transform: `translate(${box.x}px, ${box.y}px)` } : undefined;
  return { ref, style, armed, on: box !== null };
}
