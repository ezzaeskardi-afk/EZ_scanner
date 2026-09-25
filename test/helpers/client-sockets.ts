/**
 * The caller's side of the wire: how many sockets it had open to a line at once.
 *
 * `HostileLineStats.peakConcurrent` counts sessions the line has *not reaped yet*, so it runs ahead
 * of the caller by a loopback round-trip: a strictly serial caller — one socket at a time, by
 * construction — reads 2 there, and the retry churn of a reset-heavy sweep drifts further than
 * that. It is the right instrument for the question a session table answers ("did the table fill
 * up?") and the wrong one for a *worker budget*, which is a statement about the caller.
 *
 * This counts the caller's own sockets: an increment when `connect` is called on a socket aimed at
 * the line's port, a decrement when that socket is destroyed. Both ends of a socket's life are on
 * this side of the wire, so the count cannot lag — and comparing the two numbers is how the lag in
 * the paragraph above is measured instead of argued about (`hostile-line.test.ts` does that).
 *
 * Two hooks make it work, both on `net.Socket.prototype`, only while a watcher is registered:
 *   - `connect`, filtered by port, so a dial to the line is counted and a canary dial to 1.1.1.1 is
 *     not. Every dial in this project goes through it, `net.connect` and `tls.connect` alike;
 *   - `destroy`, because `destroy(socket)` in `src/core/net.ts` strips the socket's listeners before
 *     destroying it, so a `close` listener cannot be the end-of-life signal. `close` is listened for
 *     as well, and both paths are idempotent through the same `WeakMap`.
 *
 * Test-only, and deliberately intrusive: it patches a Node prototype for the life of a watcher and
 * restores it when the last one stops.
 */
import net from 'node:net';

export interface ClientSockets {
  /** Sockets the caller has open to the line right now. */
  readonly live: number;
  /** Most it had open at once — the number a worker budget is about. */
  readonly peak: number;
  /** Sockets it opened in total; a handshake that then failed was still a session opened. */
  readonly opened: number;
}

interface Counter {
  live: number;
  peak: number;
  opened: number;
  /** False once the watcher stopped: a socket destroyed afterwards is not counted any more. */
  active: boolean;
}

const watchers = new Map<number, Counter>();
/** The counter a socket was counted in, so its own end of life is counted exactly once. */
const counted = new WeakMap<object, Counter>();
let realConnect: typeof net.Socket.prototype.connect | null = null;
let realDestroy: typeof net.Socket.prototype.destroy | null = null;

/**
 * The port in `connect(options)` or `connect(port, host, cb)`; 0 for a pipe, a path, or nothing.
 *
 * `net.connect` hands `Socket.prototype.connect` the arguments it has *already* normalized, as an
 * array — so the same check has to run one level down, or a plain TCP dial is silently uncounted
 * while the TLS one is counted (the TLS path passes the options object itself).
 */
function portOf(args: unknown[]): number {
  const first = args[0];
  if (Array.isArray(first)) return portOf(first as unknown[]);
  if (typeof first === 'number') return first;
  if (first && typeof first === 'object') {
    const { port } = first as { port?: unknown };
    if (typeof port === 'number') return port;
    if (typeof port === 'string' && port.trim() !== '') return Number(port);
  }
  return 0;
}

function release(socket: object): void {
  const counter = counted.get(socket);
  if (!counter) return;
  counted.delete(socket);
  if (counter.active) counter.live -= 1;
}

function install(): void {
  if (realConnect) return;
  realConnect = net.Socket.prototype.connect;
  realDestroy = net.Socket.prototype.destroy;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const counter = watchers.get(portOf(args));
    if (counter) {
      counted.set(this, counter);
      if (counter.active) {
        counter.opened += 1;
        counter.live += 1;
        counter.peak = Math.max(counter.peak, counter.live);
      }
      // A socket closed (or reset) without its own `destroy` still ends here.
      this.once('close', () => release(this));
    }
    return Reflect.apply(realConnect as (...a: unknown[]) => net.Socket, this, args);
  } as unknown as typeof net.Socket.prototype.connect;
  net.Socket.prototype.destroy = function (this: net.Socket, ...args: unknown[]) {
    release(this);
    return Reflect.apply(realDestroy as (...a: unknown[]) => net.Socket, this, args);
  } as unknown as typeof net.Socket.prototype.destroy;
}

function uninstall(): void {
  if (!realConnect || watchers.size) return;
  net.Socket.prototype.connect = realConnect;
  if (realDestroy) net.Socket.prototype.destroy = realDestroy;
  realConnect = null;
  realDestroy = null;
}

/**
 * Starts counting sockets the caller opens to `port`. Stop it when the line closes, or the hooks
 * outlive the test that needed them (which is why `close()` in `hostile-line.ts` calls it).
 */
export function watchClientSockets(port: number): ClientSockets & { reset(): void; stop(): void } {
  const counter: Counter = { live: 0, peak: 0, opened: 0, active: true };
  watchers.set(port, counter);
  install();
  return {
    get live() {
      return counter.live;
    },
    get peak() {
      return counter.peak;
    },
    get opened() {
      return counter.opened;
    },
    /**
     * `resetStats()` semantics, the same as the line's own counters: the peak restarts from what is
     * open right now, so a phase that begins with a session already held is not read as a burst.
     */
    reset: () => {
      counter.peak = counter.live;
      counter.opened = 0;
    },
    stop: () => {
      counter.active = false;
      counter.live = 0;
      watchers.delete(port);
      uninstall();
    },
  };
}
