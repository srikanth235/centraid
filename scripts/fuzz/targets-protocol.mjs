import { utf8 } from "./mutate.mjs";
import {
  BUILD,
  HANDSHAKE_INFO_FIELDS,
  HANDSHAKE_REASONS,
  importByPath,
  invariant,
  stableStringify,
} from "./targets-support.mjs";

export const PROTOCOL_TARGETS = [
  {
    id: "protocol-handshake",
    title: "gateway info handshake judge",
    entry: "packages/core/src/protocol/handshake.ts",
    structure: "json",
    dictionary: [
      '{"version":"0.1.0","protocolVersion":3,"minSupportedProtocol":3,"capabilities":',
      '"protocolVersion":',
      '"minSupportedProtocol":',
      '"capabilities":',
      '"version":',
      '"endpointTicket":',
      '"authenticated":',
      "3",
      "-1",
      "1e309",
    ],
    iterations: 4_000_000,
    smokeIterations: 4_000,
    async load() {
      const { judgeGatewayInfo, readProtocolFromInfo, isGatewayCapabilities } =
        await importByPath("packages/core/dist/protocol/index.js", BUILD);
      return (bytes) => {
        const text = utf8(bytes);
        let value;
        let wasJson = true;
        try {
          value = JSON.parse(text);
        } catch {
          wasJson = false;
          value = text;
        }
        const result = judgeGatewayInfo(value);
        invariant(
          result !== null && typeof result === "object",
          "handshake.result-shape",
          `judgeGatewayInfo returned ${String(result)}`
        );
        if (result.ok) {
          const { info } = result;
          invariant(
            typeof info.version === "string",
            "handshake.accepted-version",
            "accepted info carries a non-string version"
          );
          invariant(
            Number.isSafeInteger(info.protocolVersion) &&
              Number.isSafeInteger(info.minSupportedProtocol),
            "handshake.accepted-protocol",
            `accepted info carries protocolVersion ${info.protocolVersion} / min ${info.minSupportedProtocol}`
          );
          invariant(
            isGatewayCapabilities(info.capabilities),
            "handshake.accepted-capabilities",
            "accepted info carries a capability map the guard rejects"
          );
          for (const key of Object.keys(info)) {
            invariant(
              HANDSHAKE_INFO_FIELDS.has(key),
              "handshake.field-leak",
              `accepted info leaked an undeclared field "${key}" from the wire`
            );
          }
          invariant(
            judgeGatewayInfo(info).ok,
            "handshake.not-idempotent",
            "re-judging an accepted GatewayInfo refuses it"
          );
        } else {
          invariant(
            HANDSHAKE_REASONS.has(result.reason),
            "handshake.reason",
            `refusal used an undeclared reason "${result.reason}"`
          );
          invariant(
            typeof result.detail === "string" && result.detail.length > 0,
            "handshake.detail",
            "refusal carries no detail string"
          );
        }
        if (value !== null && typeof value === "object") {
          const read = readProtocolFromInfo(value);
          for (const field of ["protocolVersion", "minSupportedProtocol"]) {
            invariant(
              read[field] === null || Number.isSafeInteger(read[field]),
              "handshake.protocol-read",
              `readProtocolFromInfo returned ${String(read[field])} for ${field}`
            );
          }
        }
        return `json:${wasJson}|ok:${result.ok}|${result.ok ? `accepted:${Object.keys(result.info).length}` : `${result.reason}:${result.detail.slice(0, 40)}`}`;
      };
    },
  },
  {
    id: "tunnel-wire",
    title: "pair QR payload + header frame codec",
    entry: "packages/tunnel/src/protocol.ts",
    structure: "json",
    dictionary: [
      '{"v":1,"kind":"centraid-pair","ticket":"',
      '","code":"',
      '"kind":"centraid-pair"',
      '"v":1',
      '"ticket":',
      '"code":',
      '{"method":"GET","target":"/centraid/","headers":{}}',
      '"headers":',
      '"transfer-encoding"',
    ],
    iterations: 1_600_000,
    smokeIterations: 3_000,
    async load() {
      const { parsePairQrPayload, encodeHeaderFrame } = await importByPath(
        "packages/tunnel/dist/protocol.js",
        BUILD
      );
      return (bytes) => {
        const text = utf8(bytes);
        const payload = parsePairQrPayload(text);
        if (payload !== undefined) {
          invariant(
            payload.v === 1 && payload.kind === "centraid-pair",
            "tunnel.pair-discriminant",
            "accepted a payload without the pair discriminant"
          );
          invariant(
            typeof payload.ticket === "string" &&
              typeof payload.code === "string",
            "tunnel.pair-fields",
            "accepted payload carries non-string ticket/code"
          );
          invariant(
            Object.keys(payload).length === 4,
            "tunnel.pair-field-leak",
            `accepted payload carries ${Object.keys(payload).length} fields — extra wire fields must not survive parsing`
          );
          invariant(
            stableStringify(parsePairQrPayload(JSON.stringify(payload))) ===
              stableStringify(payload),
            "tunnel.pair-roundtrip",
            "re-encoding an accepted payload does not re-parse to itself"
          );
        }
        let header;
        try {
          header = JSON.parse(text);
        } catch {
          header = { method: text.slice(0, 64), target: "/", headers: {} };
        }
        const frame = encodeHeaderFrame(header);
        invariant(
          Array.isArray(frame) && frame.length >= 4,
          "tunnel.frame-shape",
          `encodeHeaderFrame returned ${frame?.length} bytes`
        );
        invariant(
          frame.every(
            (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255
          ),
          "tunnel.frame-bytes",
          "encoded frame contains a non-byte value"
        );
        const buffer = Buffer.from(frame);
        const declared = buffer.readUInt32BE(0);
        invariant(
          declared === buffer.length - 4,
          "tunnel.frame-length",
          `length prefix says ${declared} but ${buffer.length - 4} JSON bytes follow`
        );
        const decoded = JSON.parse(buffer.subarray(4).toString("utf8"));
        invariant(
          stableStringify(decoded) === stableStringify(header),
          "tunnel.frame-roundtrip",
          "decoding an encoded header frame does not reproduce the header"
        );
        const headerShape = Array.isArray(header)
          ? `array:${Math.min(header.length, 8)}`
          : header !== null && typeof header === "object"
            ? `object:${Math.min(Object.keys(header).length, 8)}`
            : `${header === null ? "null" : typeof header}`;
        return `pair:${payload === undefined ? "reject" : "accept"}|hdr:${headerShape}|frame:${Math.min(frame.length, 512)}`;
      };
    },
  },
];
