/**
 * Free CDP debug-port allocator.
 *
 * Each launched browser gets its own remote-debugging port, exactly like
 * AdsPower hands out a fresh `debug_port` per profile. We scan a range,
 * skipping ports the manager already handed out and ports that fail a real
 * bind probe (something else is listening).
 */

const DEFAULT_START = 9333;
const DEFAULT_END = 9999;

/** Returns true if `port` is bindable right now (i.e. nothing is listening). */
export function probePortFree(port: number): boolean {
  try {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: { data() {}, open() {}, close() {}, error() {} },
    });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

export interface AllocateOptions {
  start?: number;
  end?: number;
  /** Ports already handed out by the manager; never reused while live. */
  inUse?: Set<number>;
  /** Injectable for tests. */
  probe?: (port: number) => boolean;
}

/** Find the first free port in [start, end], or throw if the range is exhausted. */
export function allocatePort(opts: AllocateOptions = {}): number {
  const start = opts.start ?? DEFAULT_START;
  const end = opts.end ?? DEFAULT_END;
  const inUse = opts.inUse ?? new Set<number>();
  const probe = opts.probe ?? probePortFree;
  for (let port = start; port <= end; port++) {
    if (inUse.has(port)) continue;
    if (probe(port)) return port;
  }
  throw new Error(`No free debug port in range ${start}-${end}`);
}
