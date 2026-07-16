// Derivative contribution vocabulary (issue #414 D9/D13).
//
// This is the one registry shared by ingress validation, staging/promotion,
// byte serving and future work-lease dispatch. Binary display rungs live in
// the CAS; semantic contributions stay inline in the derivative row so text
// can feed FTS in the same transaction and vectors/hashes never masquerade
// as rentable blob bytes. Backstops are declarations, not schedulers: the
// gateway owns when a backstop runs, while this module owns what exists and
// what a contribution must look like.

import { extractBlobMeta, sniffMediaType } from './pipeline.js';

export const DERIVATIVE_VARIANTS = [
  'thumb',
  'preview',
  'poster',
  'text',
  'transcript',
  'embedding',
  'phash',
  'thumbhash',
] as const;

export type DerivativeVariant = (typeof DERIVATIVE_VARIANTS)[number];
export type BinaryDerivativeVariant = 'thumb' | 'preview' | 'poster';
export type InlineDerivativeVariant = Exclude<DerivativeVariant, BinaryDerivativeVariant>;
export type DerivativeBackstop = 'raster-codec' | 'cheap-text' | 'optional-model' | 'none';

export interface DerivativeSpec {
  readonly variant: DerivativeVariant;
  readonly storage: 'cas' | 'inline';
  readonly mediaType: string;
  readonly maxBytes: number;
  readonly backstop: DerivativeBackstop;
}

const MIB = 1024 * 1024;

export const DERIVATIVE_REGISTRY: Readonly<Record<DerivativeVariant, DerivativeSpec>> = {
  thumb: {
    variant: 'thumb',
    storage: 'cas',
    mediaType: 'image/*',
    maxBytes: 2 * MIB,
    backstop: 'raster-codec',
  },
  preview: {
    variant: 'preview',
    storage: 'cas',
    mediaType: 'image/*',
    maxBytes: 16 * MIB,
    backstop: 'raster-codec',
  },
  poster: {
    variant: 'poster',
    storage: 'cas',
    mediaType: 'image/*',
    maxBytes: 16 * MIB,
    backstop: 'none',
  },
  text: {
    variant: 'text',
    storage: 'inline',
    mediaType: 'text/plain',
    maxBytes: MIB,
    backstop: 'cheap-text',
  },
  transcript: {
    variant: 'transcript',
    storage: 'inline',
    mediaType: 'text/plain',
    maxBytes: 4 * MIB,
    backstop: 'optional-model',
  },
  embedding: {
    variant: 'embedding',
    storage: 'inline',
    mediaType: 'application/vnd.centraid.embedding+json',
    maxBytes: 128 * 1024,
    backstop: 'optional-model',
  },
  phash: {
    variant: 'phash',
    storage: 'inline',
    mediaType: 'text/x-perceptual-hash',
    maxBytes: 64,
    backstop: 'raster-codec',
  },
  // ThumbHash (issue #419): a DCT placeholder a native client paints while a
  // real thumb streams. Canonical value is unpadded standard base64 of the
  // 5-49 byte hash; the cap covers base64 of 64 bytes (~88 chars) with slack.
  thumbhash: {
    variant: 'thumbhash',
    storage: 'inline',
    mediaType: 'application/x-thumbhash',
    maxBytes: 100,
    backstop: 'raster-codec',
  },
};

export interface ValidatedDerivative {
  readonly variant: DerivativeVariant;
  readonly storage: 'cas' | 'inline';
  readonly mediaType: string;
  readonly byteSize: number;
  /** Canonical inline representation; absent for CAS-backed rungs. */
  readonly textContent?: string;
  readonly width?: number;
  readonly height?: number;
}

export function isDerivativeVariant(value: unknown): value is DerivativeVariant {
  return typeof value === 'string' && (DERIVATIVE_VARIANTS as readonly string[]).includes(value);
}

export function isBinaryDerivative(variant: DerivativeVariant): variant is BinaryDerivativeVariant {
  return DERIVATIVE_REGISTRY[variant].storage === 'cas';
}

function decodeUtf8(bytes: Buffer, variant: DerivativeVariant): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${variant} derivative must be valid UTF-8`);
  }
}

function validateRaster(
  variant: BinaryDerivativeVariant,
  bytes: Buffer,
  declaredMediaType?: string,
): ValidatedDerivative {
  const mediaType = sniffMediaType(bytes, declaredMediaType);
  if (!mediaType.startsWith('image/') || mediaType === 'image/svg+xml') {
    throw new Error(`${variant} derivative must be a raster image`);
  }
  const meta = extractBlobMeta(bytes, mediaType);
  const width = Number(meta.width);
  const height = Number(meta.height);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 32_768 ||
    height > 32_768
  ) {
    throw new Error(`${variant} derivative has no plausible decodable dimensions`);
  }
  return { variant, storage: 'cas', mediaType, byteSize: bytes.length, width, height };
}

function canonicalEmbedding(bytes: Buffer): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes, 'embedding'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('embedding derivative must be valid JSON', { cause: error });
    }
    throw error;
  }
  const value = parsed as { model?: unknown; vector?: unknown };
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.model !== 'string' ||
    value.model.length < 1 ||
    value.model.length > 128 ||
    !Array.isArray(value.vector) ||
    value.vector.length < 1 ||
    value.vector.length > 4096 ||
    !value.vector.every((item) => typeof item === 'number' && Number.isFinite(item))
  ) {
    throw new Error('embedding derivative must be {model, vector[1..4096 finite numbers]}');
  }
  return JSON.stringify({ model: value.model, vector: value.vector });
}

/**
 * ThumbHash canonical form: unpadded standard base64 of 5..64 hash bytes.
 * Decode, bound the byte length, and re-encode to reject any non-canonical
 * spelling (padding, whitespace, base64url) so the stored value is exact.
 */
function canonicalThumbhash(text: string): string {
  if (!/^[A-Za-z0-9+/]+$/.test(text)) {
    throw new Error('thumbhash derivative must be unpadded standard base64');
  }
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length < 5 || bytes.length > 64) {
    throw new Error('thumbhash derivative must decode to 5..64 bytes');
  }
  const canonical = bytes.toString('base64').replace(/=+$/, '');
  if (canonical !== text) {
    throw new Error('thumbhash derivative is not canonical base64');
  }
  return canonical;
}

/**
 * Validate and canonicalize one contribution before it can become model.
 * The gateway route should call this before `stageBlobBytes`; staging calls
 * it for inline variants as a structural last line of defence.
 */
export function validateDerivativeContribution(input: {
  variant: DerivativeVariant;
  bytes: Buffer;
  mediaType?: string;
}): ValidatedDerivative {
  const { variant, bytes } = input;
  const spec = DERIVATIVE_REGISTRY[variant];
  if (bytes.length === 0) throw new Error(`${variant} derivative is empty`);
  if (bytes.length > spec.maxBytes) {
    throw new Error(`${variant} derivative exceeds ${spec.maxBytes} bytes`);
  }
  if (isBinaryDerivative(variant)) return validateRaster(variant, bytes, input.mediaType);

  let textContent: string;
  if (variant === 'embedding') {
    textContent = canonicalEmbedding(bytes);
  } else {
    textContent = decodeUtf8(bytes, variant).trim();
    if (variant === 'phash' && !/^[0-9a-f]{4,64}$/.test(textContent)) {
      throw new Error('phash derivative must be 4..64 lowercase hexadecimal characters');
    }
    if (variant === 'thumbhash') {
      textContent = canonicalThumbhash(textContent);
    }
    if ((variant === 'text' || variant === 'transcript') && textContent.length === 0) {
      throw new Error(`${variant} derivative is empty`);
    }
  }
  return {
    variant,
    storage: 'inline',
    mediaType: spec.mediaType,
    byteSize: Buffer.byteLength(textContent, 'utf8'),
    textContent,
  };
}
