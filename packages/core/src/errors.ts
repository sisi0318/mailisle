/** An error whose message was written for the person using the app and is safe to show as it is. */
export class UserError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 413 | 502 | 503 = 400) {
    super(message);
    this.name = 'UserError';
  }
}

/** Turns any error into a line that can be shown in the UI without leaking what a mail server answered. */
export function publicError(error: unknown): string {
  if (error instanceof UserError) return error.message;
  const details = error as { code?: unknown; authenticationFailed?: boolean; path?: unknown } | undefined;
  const code = typeof details?.code === 'string' ? details.code : undefined;
  if (error instanceof TypeError) return '客户端处理邮件时出错（TypeError），请反馈此问题';
  if (details?.authenticationFailed || code === 'EAUTH') return '邮箱登录未通过，请检查授权码或应用专用密码，以及 IMAP/SMTP 是否开启';
  // File system errors name the path they failed on, and SQLite has its own codes; neither is the mail server's fault.
  if (code && (typeof details?.path === 'string' || code.startsWith('SQLITE_'))) return `本机数据读写失败（${code}），请检查数据目录的权限和磁盘空间`;
  if (code) return `邮件服务器连接失败（${code}），请检查网络、代理和账号配置`;
  // Messages written in this codebase are Chinese. A remote server's answer can hold usernames and
  // credentials, so any other text stays out of the UI.
  if (error instanceof Error && /[㐀-鿿]/.test(error.message) && !/[\r\n]/.test(error.message)) return error.message;
  return '邮件操作未完成，请稍后重试';
}

export function errorStatus(error: unknown): 400 | 404 | 409 | 413 | 500 | 502 | 503 {
  if (error instanceof UserError) return error.status;
  const details = error as { code?: unknown; authenticationFailed?: boolean; path?: unknown } | undefined;
  const code = typeof details?.code === 'string' ? details.code : undefined;
  if (details?.authenticationFailed || (code && typeof details?.path !== 'string' && !code.startsWith('SQLITE_'))) return 502;
  if (error instanceof Error && !(error instanceof TypeError) && !code && /[㐀-鿿]/.test(error.message)) return 400;
  return 500;
}
