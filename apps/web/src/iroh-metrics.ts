interface IrohStats {
  connects: number;
  streams: number;
  reconnects: number;
}

export function irohStats(): IrohStats {
  const holder = globalThis as unknown as { __centraidIrohStats?: IrohStats };
  if (!holder.__centraidIrohStats) {
    holder.__centraidIrohStats = { connects: 0, streams: 0, reconnects: 0 };
  }
  return holder.__centraidIrohStats;
}

export function markConnectStart(): number {
  try {
    performance.mark('centraid:iroh-connect-start');
  } catch {
    /* User Timing may be unavailable; instrumentation is best-effort. */
  }
  return nowMs();
}

export function measureConnect(startMs: number): void {
  irohStats().connects += 1;
  try {
    performance.mark('centraid:iroh-connect-end');
    performance.measure('centraid:iroh-connect', {
      start: startMs,
      end: nowMs(),
    });
  } catch {
    /* best-effort */
  }
}

export function measureRequest(startMs: number): void {
  try {
    performance.measure('centraid:iroh-request', {
      start: startMs,
      end: nowMs(),
    });
  } catch {
    /* best-effort */
  }
}

export function nowMs(): number {
  try {
    return performance.now();
  } catch {
    return Date.now();
  }
}
