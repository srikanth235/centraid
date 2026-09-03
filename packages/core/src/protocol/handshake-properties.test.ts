import { assert, describe, expect, test } from "vitest";

import { fc } from "@centraid/test-kit/fast-check";

import {
  DEFAULT_GATEWAY_CAPABILITIES,
  OPTIONAL_GATEWAY_CAPABILITIES,
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
  judgeGatewayInfo,
  protocolsCompatible,
} from "./index.ts";

describe("protocol handshake property", () => {
  test("protocolsCompatible matches the CapVer mutual window", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 20 }),
        (localProtocol, localMin, peerProtocol, peerMin) => {
          const expected = peerProtocol >= localMin && localProtocol >= peerMin;
          expect(
            protocolsCompatible({
              localProtocol,
              localMin,
              peerProtocol,
              peerMin,
            })
          ).toBe(expected);
        }
      ),
      { numRuns: 64, seed: 53270 }
    );
  });

  test("equal peers are always compatible when min <= protocol", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 20 }),
        (protocol, min) => {
          fc.pre(min <= protocol);
          expect(
            protocolsCompatible({
              localProtocol: protocol,
              localMin: min,
              peerProtocol: protocol,
              peerMin: min,
            })
          ).toBe(true);
        }
      ),
      { numRuns: 32, seed: 53271 }
    );
  });

  test("judge accepts any product version string when protocol matches local", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 32 }), (version) => {
        const result = judgeGatewayInfo({
          version,
          protocolVersion: GATEWAY_PROTOCOL_VERSION,
          minSupportedProtocol: GATEWAY_MIN_PROTOCOL_VERSION,
          capabilities: DEFAULT_GATEWAY_CAPABILITIES,
        });
        expect(result.ok).toBe(true);
        assert(result.ok);
        expect(result.info.version).toBe(version);
      }),
      { numRuns: 32, seed: 53272 }
    );
  });

  test("judge fails closed on non-objects and missing version", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(42),
          fc.constant("x"),
          fc.constant([])
        ),
        (raw) => {
          const result = judgeGatewayInfo(raw);
          expect(result.ok).toBe(false);
          assert(!result.ok);
          expect(result.reason).toBe("malformed");
        }
      ),
      { numRuns: 16, seed: 53273 }
    );
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.integer()), (obj) => {
        fc.pre(typeof obj.version !== "string");
        const result = judgeGatewayInfo(obj);
        expect(result.ok).toBe(false);
      }),
      { numRuns: 24, seed: 53274 }
    );
  });

  test("judge reports protocol_mismatch when peer is outside mutual window", () => {
    const result = judgeGatewayInfo({
      version: "9.9.9",
      protocolVersion: 1,
      minSupportedProtocol: 1,
      capabilities: DEFAULT_GATEWAY_CAPABILITIES,
    });
    expect(result.ok).toBe(false);
    assert(!result.ok);
    expect(result.reason).toBe("protocol_mismatch");
  });

  test("missing protocol fields is malformed, not mismatch", () => {
    const result = judgeGatewayInfo({ version: "1.0.0" });
    expect(result.ok).toBe(false);
    assert(!result.ok);
    expect(result.reason).toBe("malformed");
  });

  test("optional instanceId/startedAt/uptimeMs are preserved only when typed correctly", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 16 }),
        fc.integer({ min: 0, max: 1e12 }),
        fc.integer({ min: 0, max: 1e9 }),
        (instanceId, startedAt, uptimeMs) => {
          const ok = judgeGatewayInfo({
            version: "1.0.0",
            protocolVersion: GATEWAY_PROTOCOL_VERSION,
            minSupportedProtocol: GATEWAY_MIN_PROTOCOL_VERSION,
            capabilities: DEFAULT_GATEWAY_CAPABILITIES,
            instanceId,
            startedAt,
            uptimeMs,
          });
          expect(ok.ok).toBe(true);
          assert(ok.ok);
          expect(ok.info.instanceId).toBe(instanceId);
          expect(ok.info.startedAt).toBe(startedAt);
          expect(ok.info.uptimeMs).toBe(uptimeMs);
          const stripped = judgeGatewayInfo({
            version: "1.0.0",
            protocolVersion: GATEWAY_PROTOCOL_VERSION,
            minSupportedProtocol: GATEWAY_MIN_PROTOCOL_VERSION,
            capabilities: DEFAULT_GATEWAY_CAPABILITIES,
            instanceId: 99,
            startedAt: "nope",
            uptimeMs: null,
          });
          expect(stripped.ok).toBe(true);
          assert(stripped.ok);
          expect(stripped.info.instanceId).toBeUndefined();
          expect(stripped.info.startedAt).toBeUndefined();
          expect(stripped.info.uptimeMs).toBeUndefined();
        }
      ),
      { numRuns: 24, seed: 53276 }
    );
  });

  test("non-integer protocolVersion is malformed", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ noInteger: true }),
          fc.string(),
          fc.constant(null)
        ),
        (bad) => {
          const result = judgeGatewayInfo({
            version: "1.0.0",
            protocolVersion: bad,
            minSupportedProtocol: GATEWAY_MIN_PROTOCOL_VERSION,
            capabilities: DEFAULT_GATEWAY_CAPABILITIES,
          });
          expect(result.ok).toBe(false);
          assert(!result.ok);
          expect(result.reason).toBe("malformed");
        }
      ),
      { numRuns: 16, seed: 53277 }
    );
  });

  test("every advertised capability is required on the handshake", () => {
    const optional = new Set<string>(OPTIONAL_GATEWAY_CAPABILITIES);
    for (const capability of Object.keys(DEFAULT_GATEWAY_CAPABILITIES)) {
      const capabilities: Record<string, unknown> = {
        ...DEFAULT_GATEWAY_CAPABILITIES,
      };
      delete capabilities[capability];
      const result = judgeGatewayInfo({
        version: "1.0.0",
        protocolVersion: GATEWAY_PROTOCOL_VERSION,
        minSupportedProtocol: GATEWAY_MIN_PROTOCOL_VERSION,
        capabilities,
      });
      expect(result.ok, capability).toBe(optional.has(capability));
      if (result.ok) continue;
      expect(result.reason, capability).toBe("malformed");
    }
  });
});
