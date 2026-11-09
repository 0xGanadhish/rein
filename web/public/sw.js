// Rein's service worker: shows EXIT alerts the Worker sends through Web Push, and opens the receipt on tap.
self.addEventListener('push', (event) => {
  let msg = { title: 'Rein called EXIT', body: 'Open Rein to see the call.', url: '/ledger' };
  try {
    msg = { ...msg, ...event.data.json() };
  } catch {
    // An unreadable payload still shows the generic alert.
  }
  event.waitUntil(
    self.registration.showNotification(msg.title, {
      body: msg.body,
      tag: `rein-exit-${msg.chain}-${msg.verdict_id}`,
      data: { url: msg.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(new URL(event.notification.data?.url ?? '/', self.location.origin).href));
});
