// Browser-side CBSF v2 sealing + presigned direct-to-CAS upload (#414).
// The gateway remains the authorizer and key root; only ciphertext takes the
// device→provider path. Store-only frames keep this dependency-free and make
// the sealed size deterministic before the gateway mints multipart URLs.
import {
  CBSF_HEADER_BYTES as HEADER_BYTES,
  CBSF_MAGIC,
  CBSF_TRAILER_BYTES as TRAILER_BYTES,
  CBSF_VERSION as VERSION,
  cbsfDirectoryAad,
  cbsfFrameAad,
  encodeCbsfDirectory,
} from '@centraid/blob-format';

const FRAME_BYTES = 4 * 1024 * 1024;
const FRAMES_PER_PART = 4;
const MAGIC = new TextEncoder().encode(CBSF_MAGIC);
const FALLBACK_CHUNK_BYTES = 16 * 1024 * 1024;

const SHA_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
const SHA_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotateRight(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

class StreamingSha256 {
  constructor(source) {
    this.words = source ? [...source.words] : [...SHA_INITIAL];
    this.bytes = source?.bytes ?? 0;
    this.pending = source ? source.pending.slice() : new Uint8Array(0);
  }

  update(input) {
    if (input.byteLength === 0) return;
    this.bytes += input.byteLength;
    const joined = new Uint8Array(this.pending.byteLength + input.byteLength);
    joined.set(this.pending);
    joined.set(input, this.pending.byteLength);
    let offset = 0;
    while (joined.byteLength - offset >= 64) {
      this.compress(joined.subarray(offset, offset + 64));
      offset += 64;
    }
    this.pending = joined.slice(offset);
  }

  digestHex() {
    const clone = new StreamingSha256(this);
    const paddingLength =
      clone.pending.byteLength < 56
        ? 56 - clone.pending.byteLength
        : 120 - clone.pending.byteLength;
    const padding = new Uint8Array(paddingLength + 8);
    padding[0] = 0x80;
    new DataView(padding.buffer).setBigUint64(paddingLength, BigInt(clone.bytes) * 8n, false);
    clone.update(padding);
    return clone.words.map((word) => word.toString(16).padStart(8, '0')).join('');
  }

  compress(block) {
    const schedule = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index += 1) schedule[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const a = schedule[index - 15];
      const b = schedule[index - 2];
      const s0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3);
      const s1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10);
      schedule[index] = (schedule[index - 16] + s0 + schedule[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.words;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choose + SHA_K[index] + schedule[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < 8; index += 1) {
      this.words[index] = (this.words[index] + next[index]) >>> 0;
    }
  }
}

/** Hash a File with bounded memory; SubtleCrypto has no streaming digest API. */
export async function sha256FileStream(file) {
  const hash = new StreamingSha256();
  if (typeof file?.stream === 'function') {
    const reader = file.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
    }
  } else {
    hash.update(new Uint8Array(await file.arrayBuffer()));
  }
  return hash.digestHex();
}

/**
 * The permanent device→gateway door. Starting with the same declared SHA
 * returns the gateway's durable open session, so a reload or lost socket only
 * repeats the hash pass and then continues at the fsynced offset. The gateway
 * may back that session with its bounded local spool or a durable provider
 * multipart upload; the browser contract is deliberately identical.
 */
export async function stageFallbackFile(file, sha256) {
  const init = await fetch('/centraid/_vault/blobs/uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedSha256: sha256,
      expectedSize: file.size,
      ...(file.type ? { mediaType: file.type } : {}),
      ...(file.name ? { filename: file.name } : {}),
    }),
  });
  if (!init.ok) return null;
  const plan = await init.json();
  if (plan.mode === 'existing') {
    return { ...plan.staged, casAck: plan.casAck, custody: plan.custody, alreadyPresent: true };
  }
  if (!plan.sessionId || !Number.isSafeInteger(plan.offset) || plan.offset < 0) {
    throw new Error('gateway did not return a resumable fallback session');
  }
  try {
    let offset = plan.offset;
    const chunkSize =
      Number.isSafeInteger(plan.chunkSize) && plan.chunkSize > 0
        ? Math.min(plan.chunkSize, FALLBACK_CHUNK_BYTES)
        : FALLBACK_CHUNK_BYTES;
    while (offset < file.size) {
      const end = Math.min(file.size, offset + chunkSize);
      const response = await fetch(
        `/centraid/_vault/blobs/uploads/${encodeURIComponent(plan.sessionId)}`,
        {
          method: 'PATCH',
          headers: { 'upload-offset': String(offset) },
          body: file.slice(offset, end),
        },
      );
      if (!response.ok) {
        throw new Error(`fallback upload refused at ${offset} (${response.status})`);
      }
      const next = Number(response.headers.get('upload-offset'));
      if (!Number.isSafeInteger(next) || next <= offset || next > file.size) {
        throw new Error('gateway returned an invalid fallback upload offset');
      }
      offset = next;
    }
    const committed = await fetch(
      `/centraid/_vault/blobs/uploads/${encodeURIComponent(plan.sessionId)}/commit`,
      { method: 'POST' },
    );
    if (!committed.ok) {
      throw new Error(`fallback upload completion refused (${committed.status})`);
    }
    return await committed.json();
  } catch (error) {
    throw asResumableError(error);
  }
}

function asResumableError(error) {
  const tagged = error instanceof Error ? error : new Error(String(error));
  tagged.resumable = true;
  return tagged;
}

function bytesFromHex(hex) {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('invalid sha256');
  return Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}

function bytesFromBase64(value) {
  const raw = atob(value);
  return Uint8Array.from({ length: raw.length }, (_, index) => raw.charCodeAt(index));
}

function concat(parts) {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function aad(sha, index, count) {
  return new TextEncoder().encode(cbsfFrameAad(sha, index, count));
}

function directoryAad(sha, count) {
  return new TextEncoder().encode(cbsfDirectoryAad(sha, count));
}

async function seal(key, plain, additionalData) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, plain),
  );
  return concat([iv, encrypted]);
}

function header(sha) {
  return concat([MAGIC, Uint8Array.of(VERSION), bytesFromHex(sha)]);
}

function trailer(directoryLength, frameCount) {
  return concat([MAGIC, Uint8Array.of(VERSION), u32(directoryLength), u32(frameCount)]);
}

function sealedSize(plainSize, frameCount) {
  // header + plaintext + (algo byte, nonce, tag + directory entry)/frame +
  // sealed fixed directory + trailer.
  return plainSize + 94 + 33 * frameCount;
}

async function sealedDirectory(key, sha, fileSize, frameCount, frameLengths) {
  const plain = encodeCbsfDirectory(FRAME_BYTES, fileSize, frameLengths);
  return seal(key, plain, directoryAad(sha, frameCount));
}

function frameLengths(fileSize, frameCount) {
  return Array.from({ length: frameCount }, (_, index) => {
    const plain = Math.min(FRAME_BYTES, fileSize - index * FRAME_BYTES);
    return plain + 29; // nonce + store-algorithm byte + plaintext + GCM tag
  });
}

async function sealPart(file, sha, key, partIndex, frameCount, directory) {
  const first = partIndex * FRAMES_PER_PART;
  const last = Math.min(frameCount, first + FRAMES_PER_PART);
  const body = [];
  if (partIndex === 0) body.push(header(sha));
  for (let index = first; index < last; index += 1) {
    const start = index * FRAME_BYTES;
    const raw = new Uint8Array(await file.slice(start, start + FRAME_BYTES).arrayBuffer());
    body.push(await seal(key, concat([Uint8Array.of(0), raw]), aad(sha, index, frameCount)));
  }
  if (last === frameCount) body.push(directory, trailer(directory.byteLength, frameCount));
  return new Blob(body);
}

function base64Of(bytes) {
  let binary = '';
  const stride = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += stride) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + stride));
  }
  return btoa(binary);
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target && typeof value === 'string') return value;
  }
  return null;
}

async function put(url, body, transferId) {
  const backgroundPut = globalThis.centraid?.transfer?.putBackground;
  if (typeof backgroundPut === 'function') {
    const bodyBase64 = base64Of(new Uint8Array(await body.arrayBuffer()));
    const response = await backgroundPut({ url, transferId, bodyBase64 });
    return headerValue(response?.headers, 'etag');
  }
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body,
  });
  if (!response.ok) throw new Error(`direct upload refused (${response.status})`);
  return response.headers.get('etag');
}

/**
 * Schedule a native background PUT without awaiting its completion. The
 * bridge posts the request synchronously, so preparing each bounded part in
 * turn keeps memory flat while all native URLSession/WorkManager transfers
 * can continue after the WebView is suspended.
 */
async function scheduleBackgroundPut(url, body, transferId) {
  const backgroundPut = globalThis.centraid?.transfer?.putBackground;
  if (typeof backgroundPut !== 'function') return null;
  const bodyBase64 = base64Of(new Uint8Array(await body.arrayBuffer()));
  const completion = backgroundPut({ url, transferId, bodyBase64 }).then((response) =>
    headerValue(response?.headers, 'etag'),
  );
  return { completion };
}

/**
 * Attempt the paired-device primary path. Returns null when this gateway or
 * caller cannot authorize direct CAS so the permanent gateway byte door can
 * take over. Once a presigned upload begins, failures surface for resumable
 * retry rather than silently shipping the full file through the gateway.
 */
export async function stageDirectFile(file, sha256) {
  if (!globalThis.crypto?.subtle) return null;
  const frameCount = file.size === 0 ? 0 : Math.ceil(file.size / FRAME_BYTES);
  const partCount = Math.max(1, Math.ceil(frameCount / FRAMES_PER_PART));
  const init = await fetch('/centraid/_vault/blobs/direct', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sha256,
      plaintextSize: file.size,
      sealedSize: sealedSize(file.size, frameCount),
      partCount,
      ...(file.type ? { mediaType: file.type } : {}),
      ...(file.name ? { filename: file.name } : {}),
    }),
  });
  if (!init.ok) return null;
  const plan = await init.json();
  if (plan.alreadyPresent)
    return plan.staged ?? { sha256, byteSize: file.size, alreadyPresent: true };
  const keyBase64 = plan.keyBase64 ?? plan.contentKey?.keyBase64;
  if (!keyBase64 || !plan.sessionId || !plan.upload) return null;
  let directBytesAccepted = (plan.completedParts?.length ?? 0) > 0;
  const key = await crypto.subtle.importKey(
    'raw',
    bytesFromBase64(keyBase64),
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const directory = await sealedDirectory(
    key,
    sha256,
    file.size,
    frameCount,
    frameLengths(file.size, frameCount),
  );
  try {
    if (plan.upload?.kind === 'single') {
      try {
        await put(
          plan.upload.url,
          await sealPart(file, sha256, key, 0, frameCount, directory),
          `${plan.sessionId}-1`,
        );
        directBytesAccepted = true;
      } catch (error) {
        // Provider unavailable before accepting any ciphertext: the gateway
        // fallback can still take durable local custody and report pending.
        if (!directBytesAccepted) return null;
        throw error;
      }
    } else if (plan.upload?.kind === 'multipart') {
      const nativeCompletions = [];
      for (const target of plan.upload.parts) {
        const index = target.partNumber - 1;
        if (index < 0 || index >= partCount) throw new Error('direct upload plan changed');
        const body = await sealPart(file, sha256, key, index, frameCount, directory);
        const transferId = `${plan.sessionId}-${target.partNumber}`;
        const scheduled = await scheduleBackgroundPut(target.url, body, transferId);
        if (scheduled) {
          nativeCompletions.push(scheduled.completion.then((etag) => ({ target, etag })));
          continue;
        }
        let etag;
        try {
          etag = await put(target.url, body, transferId);
          directBytesAccepted = true;
        } catch (error) {
          if (!directBytesAccepted) return null;
          throw error;
        }
        if (!etag) throw new Error('provider did not expose the multipart ETag');
        const receipt = await fetch(
          `/centraid/_vault/blobs/direct/${encodeURIComponent(plan.sessionId)}/parts/${target.partNumber}`,
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ etag }),
          },
        );
        if (!receipt.ok) throw new Error(`direct part receipt refused (${receipt.status})`);
      }
      const nativeResults = await Promise.allSettled(nativeCompletions);
      for (const result of nativeResults) {
        if (result.status === 'rejected') continue;
        const { target, etag } = result.value;
        directBytesAccepted = true;
        if (!etag) throw new Error('provider did not expose the background multipart ETag');
        const receipt = await fetch(
          `/centraid/_vault/blobs/direct/${encodeURIComponent(plan.sessionId)}/parts/${target.partNumber}`,
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ etag }),
          },
        );
        if (!receipt.ok) throw new Error(`direct part receipt refused (${receipt.status})`);
      }
      const failed = nativeResults.find((result) => result.status === 'rejected');
      if (failed) {
        if (!directBytesAccepted) return null;
        throw failed.reason;
      }
    } else return null;
    const committed = await fetch(
      `/centraid/_vault/blobs/direct/${encodeURIComponent(plan.sessionId)}/complete`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    if (!committed.ok) throw new Error(`direct upload completion refused (${committed.status})`);
    return await committed.json();
  } catch (error) {
    if (directBytesAccepted) throw asResumableError(error);
    throw error;
  }
}

export const CBSF_V2 = Object.freeze({ frameBytes: FRAME_BYTES, framesPerPart: FRAMES_PER_PART });
