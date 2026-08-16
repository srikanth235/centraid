import { describe, expect, test } from "vitest";

import { fc } from "@centraid/test-kit/fast-check";

import { mergeAllowedHosts, parseAllowedHostsEnv } from "./allowed-hosts.js";

/**
 * Property defense for Host allowlist merge (#545 D6 gateway mutation seed).
 *
 * Model: output hostnames are lowercased non-empty tokens; CLI order is
 * preserved ahead of env; duplicates (case-insensitive) appear once.
 */
describe("allowed-hosts properties", () => {
  const hostToken = fc
    .stringMatching(/^[A-Za-z0-9][A-Za-z0-9.-]{0,24}$/u)
    .filter((s) => s.trim().length > 0);

  test("parseAllowedHostsEnv yields lowercased non-empty tokens only", () => {
    fc.assert(
      fc.property(fc.array(hostToken, { maxLength: 8 }), (tokens) => {
        const raw = tokens.map((t) => ` ${t} `).join(",");
        const parsed = parseAllowedHostsEnv({ CENTRAID_ALLOWED_HOSTS: raw });
        expect(parsed.every((h) => h === h.toLowerCase() && h.length > 0)).toBe(
          true
        );
        expect(parsed).toStrictEqual(tokens.map((t) => t.toLowerCase()));
      }),
      { numRuns: 40, seed: 54506 }
    );
  });

  test("mergeAllowedHosts is idempotent under re-merge with empty CLI", () => {
    fc.assert(
      fc.property(fc.array(hostToken, { maxLength: 6 }), (cli) => {
        const first = mergeAllowedHosts(cli, {});
        const second = mergeAllowedHosts([], {
          CENTRAID_ALLOWED_HOSTS: first.join(","),
        });
        expect(second).toStrictEqual(first);
      }),
      { numRuns: 32, seed: 54507 }
    );
  });

  test("merge drops case-insensitive duplicates and keeps first occurrence", () => {
    fc.assert(
      fc.property(hostToken, (host) => {
        const merged = mergeAllowedHosts(
          [host, host.toUpperCase(), host.toLowerCase()],
          {
            CENTRAID_ALLOWED_HOSTS: host,
          }
        );
        expect(merged).toStrictEqual([host.toLowerCase()]);
      }),
      { numRuns: 24, seed: 54508 }
    );
  });
});
