const preferenceKey = 'mailisle-browser-notifications';
const recentKey = 'mailisle-recent-notifications';
const openEvent = 'mailisle-open-notification';
let enabled = false;
let recent: string[] = [];
let worker: Promise<ServiceWorkerRegistration | undefined> | undefined;

export function notificationPermission(): NotificationPermission | 'unavailable' {
  return window.isSecureContext && typeof Notification !== 'undefined' ? Notification.permission : 'unavailable';
}

export function browserNotificationsEnabled() {
  try { return (localStorage.getItem(preferenceKey) ?? String(enabled)) === 'true'; }
  catch { return enabled; }
}

function notificationWorker() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(undefined);
  return worker ??= navigator.serviceWorker.register('/mail-notifications.js').catch(() => {
    worker = undefined;
    return undefined;
  });
}

export async function setBrowserNotifications(value: boolean) {
  if (value) {
    const permission = notificationPermission();
    if (permission === 'unavailable' || (permission !== 'granted' && await Notification.requestPermission() !== 'granted')) return false;
    void notificationWorker();
  }
  enabled = value;
  try { localStorage.setItem(preferenceKey, String(value)); } catch { /* Keep it enabled for this tab. */ }
  return value;
}

function recentNotifications(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(recentKey) ?? 'null');
    if (Array.isArray(value)) return value.filter((id): id is string => typeof id === 'string');
  } catch { /* Storage may be blocked. */ }
  return recent;
}

export async function notifyNewMail(messageIds: string[], isConnected: () => boolean) {
  if (!browserNotificationsEnabled() || notificationPermission() !== 'granted') return;
  const show = async () => {
    const registration = await notificationWorker();
    if (!isConnected() || !browserNotificationsEnabled() || notificationPermission() !== 'granted') return;
    const previous = recentNotifications();
    const seen = new Set(previous);
    const fresh = [...new Set(messageIds)].filter(id => !seen.has(id));
    if (!fresh.length) return;
    const messageId = fresh.length === 1 ? fresh[0] : undefined;
    const title = '信屿 · 新邮件';
    const options: NotificationOptions = {
      body: '收到 ' + fresh.length + ' 封新的未读邮件',
      tag: 'mailisle-' + fresh[0], data: { messageId },
    };
    if (registration?.active) await registration.showNotification(title, options);
    else {
      const notice = new Notification(title, options);
      notice.onclick = () => {
        window.focus();
        window.dispatchEvent(new CustomEvent(openEvent, { detail: { messageId } }));
        notice.close();
      };
    }
    recent = [...fresh, ...previous].slice(0, 500);
    try { localStorage.setItem(recentKey, JSON.stringify(recent)); } catch { /* Fall back to this tab's history. */ }
  };
  if (navigator.locks) await navigator.locks.request('mailisle-new-mail-notification', show);
  else await show();
}

export function onOpenMailNotification(open: (messageId?: string) => void) {
  const handler = (event: Event) => open((event as CustomEvent<{ messageId?: string }>).detail?.messageId);
  const fromWorker = (event: MessageEvent) => {
    if (event.data?.type === openEvent) open(event.data.messageId);
  };
  window.addEventListener(openEvent, handler);
  navigator.serviceWorker?.addEventListener('message', fromWorker);
  return () => {
    window.removeEventListener(openEvent, handler);
    navigator.serviceWorker?.removeEventListener('message', fromWorker);
  };
}
