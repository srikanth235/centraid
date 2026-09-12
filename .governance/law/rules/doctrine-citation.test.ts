// @ts-nocheck — RuleTester fixtures are partial arrival records.
// Every `invalid` case is a change that moved inside settled doctrine without
// saying so, or a ruling written down with nothing behind it — the shape #1002
// landed with.
import rule from "./doctrine-citation.ts";
import { ruleTester } from "../lib/rule.ts";

const DOMAINS = [
  {
    id: "replica",
    paths: ["apps/mobile/src/lib/replica/**", "packages/client/src/replica/**"],
    decision: "#one-vault-every-seat-996",
  },
  { id: "the-law", paths: [".governance/law/**"], decision: "#governance-as-a-constitution-1005" },
];

const replicaFile = { path: "packages/client/src/replica/log.ts", status: "M", estate: "territory" };

/**
 * A receipt row as the registry carries one.
 *
 * @param {object} [overrides] Fields to replace.
 * @returns {object} The row.
 */
const receipt = (overrides = {}) => ({
  path: "receipts/issue-996-one-vault-every-seat.md",
  issue: 996,
  touched: true,
  rulings: [],
  cites: [],
  ...overrides,
});

const record = (parts) =>
  JSON.stringify(
    {
      schema: 5,
      commits: parts.commits ?? [],
      files: parts.files ?? [],
      pending: null,
      law: { domains: parts.domains ?? DOMAINS },
      registries: { receipts: { files: parts.receipts ?? [] } },
    },
    null,
    2
  );

const commit = (body) => ({
  sha: "a1",
  subject: "feat(replica): a change (#1)",
  body,
  parents: ["p"],
  files: [],
});

ruleTester().run("doctrine-citation", rule, {
  valid: [
    // Nothing in a domain was touched.
    record({ files: [{ path: "README.md", status: "M", estate: "territory" }] }),
    // The domain's issue is cited in a commit body.
    record({ files: [replicaFile], commits: [commit("Under #996, the outbox is per-seat.")] }),
    // The anchor itself, in a touched receipt.
    record({
      files: [replicaFile],
      receipts: [receipt({ cites: ["docs/decisions.md#one-vault-every-seat-996"] })],
    }),
    // A ruling that cites its issue.
    record({
      receipts: [receipt({ cites: ["#996"], rulings: [{ id: "R19", line: 30, cites: ["#996"] }] })],
    }),
    // An untouched receipt is nobody's business here.
    record({
      receipts: [receipt({ touched: false, rulings: [{ id: "R19", line: 30, cites: [] }] })],
    }),
  ],
  invalid: [
    {
      code: record({ files: [replicaFile] }),
      errors: [{ message: /touches the 'replica' domain .* and cites neither/u }],
    },
    {
      // The law is its own domain, and #1005 is the doctrine it answers to.
      code: record({
        files: [{ path: ".governance/law/rules/x.ts", status: "M", estate: "law" }],
      }),
      errors: [{ message: /touches the 'the-law' domain/u }],
    },
    {
      // #1002's own shape: a ruling id in a receipt with nothing behind it.
      code: record({
        receipts: [
          receipt({ cites: ["#996"], rulings: [{ id: "W6-D1", line: 4059, cites: [] }] }),
        ],
      }),
      errors: [{ message: /records ruling W6-D1 and cites nothing/u }],
    },
    {
      // Two uncited rulings are two findings: each is its own invented rule.
      code: record({
        receipts: [
          receipt({
            cites: ["#996"],
            rulings: [
              { id: "W6-D1", line: 4059, cites: [] },
              { id: "W6-D2", line: 4497, cites: [] },
            ],
          }),
        ],
      }),
      errors: 2,
    },
  ],
});
