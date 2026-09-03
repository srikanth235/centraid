import type { RuntimeLogger } from "@centraid/server/engine";

export function defaultLogger(tag?: string): RuntimeLogger {
  const prefix = tag ? `[${tag}] ` : "";
  return {
    info: (m) => console.info(`${prefix}${m}`),
    warn: (m) => console.warn(`${prefix}${m}`),
    error: (m) => console.error(`${prefix}${m}`),
  };
}
