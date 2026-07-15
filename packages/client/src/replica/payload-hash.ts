import { ReplicaProtocolError } from './errors.js';
import type { ReplicaValue } from './types.js';

export async function intentPayloadHash(input: {
  appId: string;
  action: string;
  input: ReplicaValue;
}): Promise<string> {
  const canonical = canonicalJson({
    action: input.action,
    appId: input.appId,
    input: input.input,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function canonicalJson(value: ReplicaValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ReplicaProtocolError('Intent payload is not JSON-safe');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(',')}}`;
}
