import { act, createElement, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';

// React only batches updates through act() when it knows it is under test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  el: HTMLElement;
  /** Every fetch the component made: its URL and parsed JSON body. */
  calls: { url: string; body: unknown }[];
  unmount(): void;
}

/** Render a client component into happy-dom with a stubbed fetch that answers `reply`. */
export async function mount<P extends object>(Component: ComponentType<P>, props: P, reply: object): Promise<Mounted> {
  const calls: Mounted['calls'] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json(reply);
    }),
  );
  const el = document.createElement('div');
  document.body.append(el);
  let root: Root;
  await act(async () => {
    root = createRoot(el);
    root.render(createElement(Component, props));
  });
  return {
    el,
    calls,
    unmount() {
      act(() => root.unmount());
      el.remove();
      vi.unstubAllGlobals();
    },
  };
}

function control<T extends HTMLElement>(el: HTMLElement, label: string, selector: string): T {
  const found = [...el.querySelectorAll('label')].find((l) => l.textContent?.startsWith(label));
  const input = found?.querySelector<T>(selector);
  if (!input) throw new Error(`No ${selector} labelled ${label}`);
  return input;
}

/** Set a labelled input or select the way a user would, so React's onChange fires. */
export async function change(el: HTMLElement, label: string, value: string): Promise<void> {
  const input = control<HTMLInputElement | HTMLSelectElement>(el, label, 'input, select');
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

export function button(el: HTMLElement, name: string): HTMLButtonElement {
  const b = [...el.querySelectorAll('button')].find((x) => x.textContent === name);
  if (!b) throw new Error(`No button ${name}`);
  return b;
}

export async function click(el: HTMLElement, name: string): Promise<void> {
  await act(async () => {
    button(el, name).click();
  });
}

export const text = (el: HTMLElement) => (el.textContent ?? '').replace(/\s+/g, ' ');
