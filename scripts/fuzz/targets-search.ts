/**
 * FTS5 search-expression fuzz targets (#839 G10).
 *
 * The two targets that eat bytes a search box chose: the gateway + replica
 * MATCH compilers, and the mirror property that the replica compiler produces
 * the same program as the canonical gateway.
 */
import { utf8 } from "./mutate.ts";
import {
  assertFtsGrammar,
  BUILD,
  CLIENT_SOURCE_HINT,
  importByPath,
  invariant,
  moduleFn,
} from "./targets-support.ts";
import type { FuzzTarget } from "./targets-support.ts";

type FtsCompiler = (query: string) => string | null;

export const SEARCH_TARGETS: FuzzTarget[] = [
  {
    id: "fts-match",
    title: "FTS5 MATCH expression compilers (gateway + replica)",
    entry: "packages/vault/src/gateway/search.ts",
    structure: "text",
    dictionary: [
      '"',
      "*",
      "AND",
      "OR",
      "NOT",
      "NEAR",
      "-",
      "^",
      ":",
      "(",
      ")",
      "\u0301",
      "\u200B",
      "  ",
      "budget",
    ],
    iterations: 2_800_000,
    smokeIterations: 4_000,
    async load() {
      const gatewayMod = await importByPath(
        "packages/vault/dist/gateway/search.js",
        BUILD
      );
      const replicaMod = await importByPath(
        "packages/client/src/replica/search.ts",
        CLIENT_SOURCE_HINT
      );
      const ftsMatchExpression = moduleFn<FtsCompiler>(
        gatewayMod,
        "ftsMatchExpression"
      );
      const replicaFtsMatchExpression = moduleFn<FtsCompiler>(
        replicaMod,
        "replicaFtsMatchExpression"
      );
      return (bytes: Uint8Array) => {
        const query = utf8(bytes);
        const gateway = ftsMatchExpression(query);
        if (gateway !== null) assertFtsGrammar(gateway, "fts.gateway");
        let replica: string | null = null;
        let refusal: unknown = null;
        try {
          replica = replicaFtsMatchExpression(query);
        } catch (error) {
          refusal = error;
        }
        if (refusal) {
          invariant(
            refusal instanceof Error && refusal.name === "ReplicaProtocolError",
            "fts.replica-untyped-throw",
            `replica compiler threw an untyped ${String(refusal)}`
          );
        } else if (replica !== null) {
          assertFtsGrammar(replica, "fts.replica");
        }
        const terms = (expression: string | null): string =>
          expression === null ? "null" : String(expression.split(" ").length);
        return `gw:${terms(gateway)}|rep:${refusal ? "refuse" : terms(replica)}|punct:${gateway !== null && /[^\p{L}\p{N}"*\s]/u.test(gateway)}`;
      };
    },
  },
  {
    id: "fts-mirror",
    title: "replica FTS compiler mirrors the canonical gateway",
    entry: "packages/client/src/replica/search.ts",
    structure: "text",
    dictionary: [
      "-",
      ".",
      "_",
      "'",
      "\u0301",
      "a-b",
      "3.14",
      "don't",
      "budget",
      " ",
    ],
    iterations: 3_600_000,
    smokeIterations: 3_000,
    async load() {
      const gatewayMod = await importByPath(
        "packages/vault/dist/gateway/search.js",
        BUILD
      );
      const replicaMod = await importByPath(
        "packages/client/src/replica/search.ts",
        CLIENT_SOURCE_HINT
      );
      const ftsMatchExpression = moduleFn<FtsCompiler>(
        gatewayMod,
        "ftsMatchExpression"
      );
      const replicaFtsMatchExpression = moduleFn<FtsCompiler>(
        replicaMod,
        "replicaFtsMatchExpression"
      );
      return (bytes: Uint8Array) => {
        const query = utf8(bytes);
        const gateway = ftsMatchExpression(query);
        let replica: string | null = null;
        let refused = false;
        try {
          replica = replicaFtsMatchExpression(query);
        } catch {
          // A refusal is the replica's way of saying "no searchable words";
          // the gateway says the same thing by returning null.
          refused = true;
        }
        invariant(
          refused === (gateway === null),
          "fts-mirror.decision",
          `gateway ${gateway === null ? "refused" : "compiled"} but replica ${refused ? "refused" : "compiled"}: ${JSON.stringify(query)}`
        );
        if (!refused) {
          invariant(
            replica === gateway,
            "fts-mirror.expression",
            `gateway compiled ${JSON.stringify(gateway)} but replica compiled ${JSON.stringify(replica)}: ${JSON.stringify(query)}`
          );
        }
        return `agree:${refused ? "refuse" : `${replica === gateway}:${(gateway ?? "").split(" ").length}`}`;
      };
    },
  },
];
