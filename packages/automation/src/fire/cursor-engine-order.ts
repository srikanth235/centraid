import type { Trigger } from '../manifest/manifest.js';

/** Apply work serially when each durable effect is the next operation's precondition. */
export function applyInOrder<T>(
  values: readonly T[],
  apply: (value: T, index: number) => void | PromiseLike<void>,
  index = 0,
): Promise<void> {
  const value = values[index];
  if (value === undefined) return Promise.resolve();
  return Promise.resolve(apply(value, index)).then(() => applyInOrder(values, apply, index + 1));
}

export function eventSourceKey(trigger: Extract<Trigger, { kind: 'event' }>): string {
  return `event:${trigger.connectorKind}:${trigger.event}`;
}
