self.addEventListener('notificationclick', event => {
  event.notification.close();
  const id = event.notification.data?.messageId;
  const messageId = typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? id : undefined;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const mailbox = windows.find(client => new URL(client.url).pathname === '/');
    if (mailbox) {
      try {
        await mailbox.focus();
        mailbox.postMessage({ type: 'mailisle-open-notification', messageId });
        return;
      } catch { /* The window may have closed in the meantime. */ }
    }
    await self.clients.openWindow(messageId ? '/#mail=' + messageId : '/');
  })());
});
