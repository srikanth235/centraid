/**
 * Single SW generation token (#468).
 * Consumed by iroh-transport (script URL ?v=), mirrored into public/sw.js
 * VERSION, and inherited by the worker-owned Iroh JS/WASM URLs. Bump this when
 * the worker protocol, Iroh binding, or shell cache buckets need a hard refresh.
 */
export const SERVICE_WORKER_VERSION = "v13";
