/** A failed request. `status` is 0 when the service could not be reached at all. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options, headers: { ...(options?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...options?.headers },
    });
  } catch { throw new ApiError('无法连接信屿服务，请检查网络后重试', 0); }
  // A proxy in front of the service answers its own errors with an HTML page, so the body is not assumed to be JSON.
  let body: unknown;
  try { body = JSON.parse(await response.text()); } catch { body = undefined; }
  if (!response.ok) {
    if (response.status === 401 && path !== '/login') window.dispatchEvent(new Event('session-expired'));
    const message = (body as { error?: unknown } | undefined)?.error;
    throw new ApiError(typeof message === 'string' ? message
      : response.status === 413 ? '内容过大，服务或反向代理拒绝了这次请求'
      : response.status >= 502 && response.status <= 504 ? '信屿服务暂时不可用，请稍后重试' : '请求失败，请稍后重试', response.status);
  }
  if (body === undefined) throw new ApiError('服务返回了无法识别的内容，请稍后重试', response.status);
  return body as T;
}

export const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });
