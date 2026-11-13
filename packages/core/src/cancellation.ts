export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

export async function settleWithin(tasks: { kind: string; done: Promise<unknown> }[], timeoutMs: number) {
  const pending = new Map(tasks.map((task, index) => [index, task.kind]));
  const failed: string[] = [];
  const settled = Promise.all(tasks.map((task, index) => task.done.catch(() => { failed.push(task.kind); }).finally(() => { pending.delete(index); })));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([settled, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
    return { pending: [...pending.values()], failed };
  } finally { clearTimeout(timer); }
}
