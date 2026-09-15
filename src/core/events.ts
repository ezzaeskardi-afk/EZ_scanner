/** Dependency-free, typed event emitter. */
export type Listener<T> = (payload: T) => void;

export class Emitter<Events extends object> {
  private listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as Listener<never>);
    return () => this.off(event, fn);
  }

  once<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    const dispose = this.on(event, ((payload: Events[K]) => {
      dispose();
      fn(payload);
    }) as Listener<Events[K]>);
    return dispose;
  }

  off<K extends keyof Events>(event: K, fn: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(fn as Listener<never>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as Listener<Events[K]>)(payload);
      } catch {
        /* a broken listener must never break a scan */
      }
    }
  }

  removeAll(): void {
    this.listeners.clear();
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      done();
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function throttle<T>(fn: (value: T) => void, ms: number): (value: T) => void {
  let last = 0;
  let pending: T | null = null;
  let timer: NodeJS.Timeout | null = null;
  return (value: T) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(value);
      return;
    }
    pending = value;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      last = Date.now();
      if (pending !== null) {
        const next = pending;
        pending = null;
        fn(next);
      }
    }, ms - (now - last));
  };
}

/** Runs `fn` over `items` with a fixed concurrency, honouring an abort signal. */
export async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let cursor = 0;
  const size = Math.max(1, Math.min(concurrency, items.length || 1));
  const workers = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      if (signal?.aborted) return;
      const index = cursor++;
      const item = items[index];
      if (item === undefined) return;
      await fn(item, index);
    }
  });
  await Promise.all(workers);
}
