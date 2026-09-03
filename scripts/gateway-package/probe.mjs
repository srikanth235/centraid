#!/usr/bin/env node

export const INFO_PATH = "/centraid/_gateway/info";

export async function probeGatewayInfo(baseUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const url = `${baseUrl.replace(/\/$/u, "")}${INFO_PATH}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    const body = await res.json().catch(() => null);
    let ok = res.status === 200 || res.status === 401;
    if (res.status === 200 && body && typeof body.version !== "string")
      ok = false;
    return {
      ok,
      status: res.status,
      detail: JSON.stringify({ status: res.status, body }),
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForGatewayInfo(baseUrl, opts = {}) {
  const deadlineMs = opts.deadlineMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 200;
  const deadline = Date.now() + deadlineMs;
  let last = { ok: false, detail: "not attempted" };
  const poll = async () => {
    if (Date.now() >= deadline) return last;
    last = await probeGatewayInfo(baseUrl, { timeoutMs: 2_000 });
    if (last.ok) return last;
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
    return poll();
  };
  return poll();
}
