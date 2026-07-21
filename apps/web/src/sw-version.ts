/**
 * Single SW generation token (issue #468 K8).
 * Consumed by iroh-transport (script URL ?v=) and mirrored into public/sw.js
 * VERSION. Bump this when either the worker protocol or shell cache buckets
 * need a hard refresh.
 */
export const SERVICE_WORKER_VERSION = 'v11';
