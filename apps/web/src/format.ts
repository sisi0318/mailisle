import type { Folder, FolderRole, Message } from '@mail/shared';

const day = 86_400_000;
const pad = (value: number) => String(value).padStart(2, '0');

/** Compact date for list rows: the time today, "昨天", month and day this year, the full date before that. */
export function listDate(timestamp: number, now = new Date()): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (timestamp >= today) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (timestamp >= today - day) return '昨天';
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

export function fullDate(timestamp: number): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const senderName = (message: Message) => message.from[0]?.name || message.from[0]?.address || '未知发件人';

const accountColors = ['#2f7d62', '#96702a', '#4a6aa5', '#96506e', '#5c7a2c', '#765c9e'];
export const accountColor = (index: number) => accountColors[index % accountColors.length];

const roleLabels: Record<FolderRole, string | null> = { inbox: '收件箱', drafts: '草稿箱', sent: '已发送', archive: '归档', junk: '垃圾邮件', trash: '已删除', other: null };
const roleOrder = Object.keys(roleLabels) as FolderRole[];

/**
 * Folders in display order with their display names. Only the first folder of a role gets the
 * role's name; a second one (Gmail has two archive-like folders) keeps the server's name.
 */
export function folderList(folders: Folder[]): { folder: Folder; label: string }[] {
  const named = new Set<string>();
  return [...folders]
    .sort((a, b) => a.accountId.localeCompare(b.accountId) || roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role) || a.name.localeCompare(b.name, 'zh-CN'))
    .map(folder => {
      const key = `${folder.accountId}:${folder.role}`;
      const label = (!named.has(key) && roleLabels[folder.role]) || (folder.path === folder.name ? folder.name : folder.path);
      named.add(key);
      return { folder, label };
    });
}

export type FolderNode = { key: string; accountId: string; path: string; label: string; folder?: Folder; children: FolderNode[] };
export function folderTree(folders: Folder[]): FolderNode[] {
  const nodes = new Map<string, FolderNode>();
  for (const { folder, label } of folderList(folders)) {
    const key = `${folder.accountId}:${folder.path}`;
    nodes.set(key, { key, accountId: folder.accountId, path: folder.path, label: label === folder.path ? folder.name : label, folder, children: [] });
  }
  const roots: FolderNode[] = [];
  for (const folder of folders) {
    let node = nodes.get(`${folder.accountId}:${folder.path}`)!;
    let path = folder.path;
    while (folder.delimiter && path.includes(folder.delimiter)) {
      path = path.slice(0, path.lastIndexOf(folder.delimiter));
      if (!path) break;
      const key = `${folder.accountId}:${path}`;
      let parent = nodes.get(key);
      if (!parent) {
        parent = { key, accountId: folder.accountId, path, label: path.split(folder.delimiter).at(-1)!, children: [] };
        nodes.set(key, parent);
      }
      if (!parent.children.includes(node)) parent.children.push(node);
      node = parent;
    }
    if (!roots.includes(node)) roots.push(node);
  }
  function sort(items: FolderNode[]): FolderNode[] {
    items.sort((a, b) => roleOrder.indexOf(a.folder?.role ?? 'other') - roleOrder.indexOf(b.folder?.role ?? 'other') || a.label.localeCompare(b.label, 'zh-CN'));
    for (const item of items) sort(item.children);
    return items;
  }
  return sort(roots);
}

type Issue = { path: PropertyKey[]; message: string };

/** Turns schema issues into one readable line. `labels` maps a field path such as "imap.host" to its form label. */
export function describeIssues(issues: Issue[], labels: Record<string, string>): string {
  const lines = issues.map(issue => {
    const label = labels[issue.path.filter(part => typeof part === 'string').join('.')] ?? labels[String(issue.path[0])] ?? '输入内容';
    // Messages written for this app are Chinese. The validator's built-in ones are English and say little to a user.
    if (/[㐀-鿿]/.test(issue.message)) return `${label}：${issue.message}`;
    const index = issue.path.find(part => typeof part === 'number');
    return typeof index === 'number' ? `${label}第 ${index + 1} 个地址格式不正确` : `${label}格式不正确`;
  });
  return [...new Set(lines)].join('；');
}
