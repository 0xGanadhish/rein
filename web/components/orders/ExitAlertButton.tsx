'use client';

import { useEffect, useState } from 'react';

type State = 'loading' | 'off' | 'unsupported' | 'idle' | 'on' | 'denied' | 'error';

const fromB64u = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );
const SUBSCRIBED = (chain: string, vault: string) => `rein-alert:${chain}:${vault.toLowerCase()}`;

/**
 * Subscribes this browser to a push notification whenever Rein posts an EXIT on this vault. It's a signal, not a
 * protection, and says so. Hidden while the Worker has no VAPID key; on iPhone, push needs the site on the Home Screen.
 */
export function ExitAlertButton({
  api,
  chain,
  vault,
  className,
}: {
  api: string | null;
  chain: string;
  vault: string;
  className: string;
}) {
  const [state, setState] = useState<State>('loading');
  const [key, setKey] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return setState('off');
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      return setState('unsupported');
    }
    fetch(new URL('/v1/alerts/key', api))
      .then((r) => r.json() as Promise<{ key: string | null }>)
      .then(({ key }) => {
        if (!key) return setState('off');
        setKey(key);
        let on = false;
        try {
          on = localStorage.getItem(SUBSCRIBED(chain, vault)) === '1';
        } catch {
          // Storage can be blocked; the button then starts as "Alert me" and subscribing again is harmless.
        }
        setState(Notification.permission === 'denied' ? 'denied' : on ? 'on' : 'idle');
      })
      .catch(() => setState('off'));
  }, [api, chain, vault]);

  const change = async (on: boolean) => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      if (on && (await Notification.requestPermission()) !== 'granted') return setState('denied');
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (on ? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(key!) }) : null);
      if (!sub) return setState('idle');
      const res = await fetch(new URL(on ? '/v1/alerts/subscribe' : '/v1/alerts/unsubscribe', api!), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), chain, vault }),
      });
      if (!res.ok) return setState('error');
      try {
        if (on) localStorage.setItem(SUBSCRIBED(chain, vault), '1');
        else localStorage.removeItem(SUBSCRIBED(chain, vault));
      } catch {
        // Blocked storage only forgets the button's state.
      }
      setState(on ? 'on' : 'idle');
    } catch {
      setState('error');
    }
  };

  if (state === 'loading' || state === 'off') return null;
  const note: Partial<Record<State, string>> = {
    unsupported: 'This browser can’t receive alerts. On iPhone, add Rein to your Home Screen first.',
    denied: 'Notifications are blocked for this site in your browser settings.',
    error: 'The alert didn’t save. Try again.',
    on: 'You’ll get a notification when Rein calls EXIT on this vault. It doesn’t move your funds.',
  };
  return (
    <>
      {(state === 'idle' || state === 'error' || state === 'on') && (
        <button
          type="button"
          className={className}
          onClick={() => void change(state !== 'on')}
          aria-pressed={state === 'on'}
        >
          {state === 'on' ? 'Stop EXIT alerts' : 'Alert me on EXIT'}
        </button>
      )}
      {note[state] && <p style={{ margin: 0, fontSize: 13, color: 'var(--mute)' }}>{note[state]}</p>}
    </>
  );
}
