import { utf8 } from "./mutate.mjs";
import {
  assertFtsGrammar,
  BUILD,
  CLIENT_SOURCE_HINT,
  importByPath,
  invariant,
} from "./targets-support.mjs";

export const SEARCH_TARGETS = [
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
      const { ftsMatchExpression } = await importByPath(
        "packages/vault/dist/gateway/search.js",
        BUILD
      );
      const { replicaFtsMatchExpression } = await importByPath(
        "packages/client/src/replica/search.ts",
        CLIENT_SOURCE_HINT
      );
      return (bytes) => {
        const query = utf8(bytes);
        const gateway = ftsMatchExpression(query);
        if (gateway !== null) assertFtsGrammar(gateway, "fts.gateway");
        let replica = null;
        let refusal = null;
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
        } else {
          assertFtsGrammar(replica, "fts.replica");
        }
        const terms = (expression) =>
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
      const { ftsMatchExpression } = await importByPath(
        "packages/vault/dist/gateway/search.js",
        BUILD
      );
      const { replicaFtsMatchExpression } = await importByPath(
        "packages/client/src/replica/search.ts",
        CLIENT_SOURCE_HINT
      );
      return (bytes) => {
        const query = utf8(bytes);
        const gateway = ftsMatchExpression(query);
        let replica = null;
        let refused = false;
        try {
          replica = replicaFtsMatchExpression(query);
        } catch {
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
        return `agree:${refused ? "refuse" : `${replica === gateway}:${gateway.split(" ").length}`}`;
      };
    },
  },
];
