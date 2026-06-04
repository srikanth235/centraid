/*
 * Default `RuntimeLogger` for `buildGateway` — a console logger with an
 * optional `[tag]` prefix. Hosts that want structured logging pass their
 * own via `BuildGatewayOptions.logger`.
 */

import type { RuntimeLogger } from '@centraid/app-engine';

export function defaultLogger(tag?: string): RuntimeLogger {
  const prefix = tag ? `[${tag}] ` : '';
  return {
    info: (m) => console.info(`${prefix}${m}`),
    warn: (m) => console.warn(`${prefix}${m}`),
    error: (m) => console.error(`${prefix}${m}`),
  };
}
