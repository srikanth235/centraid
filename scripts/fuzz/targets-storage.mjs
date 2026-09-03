import { utf8 } from "./mutate.mjs";
import {
  assertKeyRoundtrip,
  BUILD,
  corruptionOffsets,
  importByPath,
  invariant,
  isUint32,
  stableStringify,
  UINT32_MAX,
} from "./targets-support.mjs";

export const STORAGE_TARGETS = [
  {
    id: "cbsf-directory",
    title: "CBSF v2 blob directory decoder",
    entry: "packages/core/src/blob/cbsf.ts",
    structure: "bytes",
    dictionary: ["CBSF"],
    iterations: 2_000_000,
    smokeIterations: 1_500,
    async load() {
      const { decodeCbsfDirectory, encodeCbsfDirectory } = await importByPath(
        "packages/core/dist/blob/index.js",
        BUILD
      );
      const frameCountsFor = (bytes) => {
        const exact =
          bytes.length >= 16 && (bytes.length - 16) % 4 === 0
            ? (bytes.length - 16) / 4
            : 0;
        const fromBytes =
          bytes.length >= 4
            ? new DataView(
                bytes.buffer,
                bytes.byteOffset,
                bytes.byteLength
              ).getUint32(0, false)
            : 0;
        return [exact, bytes[0] ?? 0, fromBytes, UINT32_MAX];
      };
      return (bytes) => {
        const outcomes = [];
        for (const frameCount of frameCountsFor(bytes)) {
          let decoded = null;
          let failure = null;
          try {
            decoded = decodeCbsfDirectory(bytes, frameCount);
          } catch (error) {
            failure = error;
          }
          if (failure) {
            invariant(
              failure instanceof Error,
              "cbsf.non-error-throw",
              `decode threw a non-Error: ${String(failure)}`
            );
            invariant(
              failure.message.startsWith("CBSF directory "),
              "cbsf.uncontrolled-error",
              `decode threw an uncontrolled ${failure.name}: ${failure.message}`
            );
            outcomes.push("reject");
            continue;
          }
          invariant(
            isUint32(decoded.frameSize),
            "cbsf.frame-size",
            `frameSize ${decoded.frameSize} is not a uint32`
          );
          invariant(
            Number.isSafeInteger(decoded.totalSize) && decoded.totalSize >= 0,
            "cbsf.total-size",
            `totalSize ${decoded.totalSize} is not a non-negative safe integer`
          );
          invariant(
            decoded.sealedLens.length === frameCount &&
              decoded.sealedLens.every(isUint32),
            "cbsf.sealed-lens",
            `sealedLens has ${decoded.sealedLens.length} uint32 entries for frameCount ${frameCount}`
          );
          invariant(
            Buffer.compare(
              Buffer.from(
                encodeCbsfDirectory(
                  decoded.frameSize,
                  decoded.totalSize,
                  decoded.sealedLens
                )
              ),
              Buffer.from(bytes)
            ) === 0,
            "cbsf.roundtrip",
            "re-encoding a decoded directory is not byte-identical to its input"
          );
          for (const offset of corruptionOffsets(bytes.length)) {
            const corrupted = Uint8Array.from(bytes);
            corrupted[offset] ^= 0x80;
            let corruptDecoded = null;
            let corruptFailure = null;
            try {
              corruptDecoded = decodeCbsfDirectory(corrupted, frameCount);
            } catch (error) {
              corruptFailure = error;
            }
            if (corruptFailure) {
              invariant(
                corruptFailure instanceof Error &&
                  corruptFailure.message.startsWith("CBSF directory "),
                "cbsf.uncontrolled-error",
                `corrupted decode threw an uncontrolled error: ${String(corruptFailure)}`
              );
              continue;
            }
            invariant(
              stableStringify(corruptDecoded) !== stableStringify(decoded),
              "cbsf.silent-corruption",
              `flipping bit 7 of byte ${offset} decodes to the same directory — the byte is not read`
            );
          }
          outcomes.push(`accept:${decoded.sealedLens.length}`);
        }
        return `len:${bytes.length}|${outcomes.join(",")}`;
      };
    },
  },
  {
    id: "wal-keys",
    title: "WAL segment / closer / pair-marker key parsers",
    entry: "packages/backup/src/wal-format.ts",
    structure: "text",
    dictionary: [
      "wal/vault/",
      "wal/journal/",
      "wal/tick/",
      "closed-",
      "00000000",
      "000000000000",
      "0000000000000",
      "0123456789abcdef0123456789abcdef",
      "-",
      "/",
    ],
    iterations: 14_000_000,
    smokeIterations: 6_000,
    async load() {
      const {
        parseWalSegmentKey,
        parseWalCloserKey,
        parseWalPairMarkerKey,
        walSegmentKey,
        walGroupCloserKey,
        walPairMarkerKey,
      } = await importByPath("packages/backup/dist/wal-format.js", BUILD);
      const GENERATION = /^[0-9a-f]{32}$/u;
      const isOffset = (value) =>
        Number.isSafeInteger(value) && value >= 0 && value <= 999_999_999_999;
      return (bytes) => {
        const key = utf8(bytes);
        const segment = parseWalSegmentKey(key);
        const closer = parseWalCloserKey(key);
        const marker = parseWalPairMarkerKey(key);
        invariant(
          [segment, closer, marker].filter(Boolean).length <= 1,
          "wal.ambiguous-key",
          `key parses as more than one WAL object kind: ${JSON.stringify(key)}`
        );
        if (segment) {
          invariant(
            segment.db === "vault" || segment.db === "journal",
            "wal.segment-db",
            `segment db "${segment.db}" is not a WAL database`
          );
          invariant(
            GENERATION.test(segment.generation),
            "wal.segment-generation",
            `segment generation "${segment.generation}" is not 32 lowercase hex`
          );
          invariant(
            isOffset(segment.startOffset) &&
              isOffset(segment.endOffset) &&
              segment.endOffset > segment.startOffset,
            "wal.segment-offsets",
            `segment offsets ${segment.startOffset}..${segment.endOffset} are not a forward range`
          );
          invariant(
            Number.isSafeInteger(segment.group) &&
              segment.group >= 0 &&
              Number.isSafeInteger(segment.tickMs) &&
              segment.tickMs >= 0,
            "wal.segment-numbers",
            `segment group ${segment.group} / tick ${segment.tickMs} are not non-negative safe integers`
          );
          assertKeyRoundtrip(
            walSegmentKey,
            segment,
            key,
            "wal.segment-roundtrip"
          );
        }
        if (closer) {
          invariant(
            (closer.db === "vault" || closer.db === "journal") &&
              GENERATION.test(closer.generation) &&
              Number.isSafeInteger(closer.group) &&
              closer.group >= 0 &&
              isOffset(closer.endOffset),
            "wal.closer-fields",
            `closer fields are out of contract: ${JSON.stringify(closer)}`
          );
          assertKeyRoundtrip(
            walGroupCloserKey,
            closer,
            key,
            "wal.closer-roundtrip"
          );
        }
        if (marker) {
          invariant(
            GENERATION.test(marker.vaultGeneration) &&
              GENERATION.test(marker.journalGeneration) &&
              Number.isSafeInteger(marker.tickMs) &&
              marker.tickMs >= 0,
            "wal.marker-fields",
            `pair-marker fields are out of contract: ${JSON.stringify(marker)}`
          );
          assertKeyRoundtrip(
            walPairMarkerKey,
            marker,
            key,
            "wal.marker-roundtrip"
          );
        }
        const kind = segment
          ? "segment"
          : closer
            ? "closer"
            : marker
              ? "marker"
              : "none";
        return `${kind}|seg:${key.split("/").length}|head:${key.slice(0, 4)}`;
      };
    },
  },
];
