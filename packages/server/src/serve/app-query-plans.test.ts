/*
 * THE COMMITTED QUERY PLANS (#996 wave 4, ruling R8).
 *
 * Every shipped app handler is invoked against a REAL vault through the paged
 * door (W4-D2), every statement it issues is captured, and each statement's
 * `EXPLAIN QUERY PLAN` is written to `app-query-plans.snapshot.md`. That file
 * is the derived manifest a reviewer reads: it names, per app and per handler,
 * the SQL the app actually runs and the access path SQLite chose for it, so a
 * handler that starts scanning a table shows up as a diff in a review rather
 * than as a slow screen a year later.
 *
 * It is NOT the performance gate — R8 is explicit that an outer `LIMIT` does
 * not bound a sort, that an efficient ordered traversal can print as `SCAN`,
 * and that plan text moves between SQLite versions. The gate is measured work
 * at year-3 scale in the journey ledger. What this file is for is REVIEW: the
 * statement and its access path, in one place, under version control.
 *
 * It also carries the property `app-manifest-reads.test.ts` used to assert by
 * regex over sources — every table a handler reads is one its manifest
 * declares — and it carries it from the statements that ran, not from a
 * pattern over text.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { pageStatement } from "@centraid/core/page";
import type { PageQuery } from "@centraid/core/page";
import { schemaFixture } from "@centraid/test-kit/manifest-fixture-input";
import type { JsonSchema } from "@centraid/test-kit/manifest-fixture-input";
import { tempDirSync } from "@centraid/test-kit/temp-dir";
import { bootstrapVault, createGateway, openVaultDb } from "@centraid/vault";
import type { Credential, ScopeSpec } from "@centraid/vault";

const APPS_ROOT = path.resolve(import.meta.dirname, "../../../blueprints/apps");

interface ManifestHandler {
  name: string;
  input?: JsonSchema;
}

interface AppJson {
  id: string;
  vault: { scopes: ScopeSpec[] };
  queries?: ManifestHandler[];
}

/** The eight shipped apps, in the order the snapshot is written in. */
const APP_IDS = [
  "agenda",
  "docs",
  "locker",
  "notes",
  "people",
  "photos",
  "tally",
  "tasks",
] as const;

function manifestOf(appId: string): AppJson {
  return JSON.parse(
    readFileSync(path.join(APPS_ROOT, appId, "app.json"), "utf8")
  ) as AppJson;
}

/** One captured statement: what the handler asked for, and what it compiled to. */
interface CapturedPlan {
  handler: string;
  name: string;
  sql: string;
  tables: string[];
  plan: string[];
}

/** Every physical table a `FROM` clause names, joins included. */
function tablesOf(from: string): string[] {
  const names: string[] = [];
  for (const part of from.split(
    /\s+(?:left\s+|inner\s+|cross\s+)?join\s+|\s+on\s+[^,]*/iu
  )) {
    const name = part.trim().split(/\s+/u)[0];
    if (name && /^[a-z][a-z\d_]*_[a-z]/u.test(name)) names.push(name);
  }
  return [...new Set(names)];
}

function declaresTable(scopes: readonly ScopeSpec[], table: string): boolean {
  const cut = table.indexOf("_");
  const schema = table.slice(0, cut);
  const rest = table.slice(cut + 1);
  return scopes.some(
    (scope) =>
      scope.verbs.includes("read") &&
      scope.schema === schema &&
      (scope.table === undefined || scope.table === rest)
  );
}

describe("every app handler's query plan, committed (#996 R8)", () => {
  let db: ReturnType<typeof openVaultDb>;
  let gateway: ReturnType<typeof createGateway>;
  let credentialFor: (appId: string) => Credential;
  const captured = new Map<string, CapturedPlan[]>();

  beforeAll(async () => {
    const dir = tempDirSync("centraid-app-query-plans-");
    db = openVaultDb({ dir });
    const boot = bootstrapVault(db, { ownerName: "Plan owner" });
    gateway = createGateway(db);
    credentialFor = (appId) => ({
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
      surface: appId,
      scopeClamp: manifestOf(appId).vault.scopes,
    });

    for (const appId of APP_IDS) {
      const manifest = manifestOf(appId);
      const credential = credentialFor(appId);
      const plans: CapturedPlan[] = [];
      for (const handler of manifest.queries ?? []) {
        const seen: PageQuery[] = [];
        const ctx = {
          vault: {
            read: (request: unknown) =>
              Promise.resolve(gateway.read(credential, request as never)),
            search: (request: unknown) =>
              Promise.resolve(gateway.search(credential, request as never)),
            page: (request: {
              query: PageQuery;
              limit: number;
              after?: { sortKey: string; pk: string };
            }) => {
              seen.push(request.query);
              return Promise.resolve(
                gateway.page(credential, request.query, {
                  limit: request.limit,
                  ...(request.after ? { after: request.after } : {}),
                })
              );
            },
            resolve: () => Promise.resolve({ cards: [] }),
            reveal: () =>
              Promise.resolve({ values: {}, receiptId: "plan-receipt" }),
            authenticate: () =>
              Promise.resolve({ ok: true, configured: false }),
          },
        };
        const input = schemaFixture(handler.input);
        // oxlint-disable-next-line no-await-in-loop -- one vault, one gateway: the statements are captured in manifest order so the snapshot is stable, and running eight apps' handlers in parallel against one SQLite file would interleave the capture
        const module = (await import(
          /* @vite-ignore */ `@centraid/blueprints/apps/${appId}/queries/${handler.name}`
        )) as { default: (args: never) => Promise<unknown> };
        // oxlint-disable-next-line no-await-in-loop -- see above: the capture is ordered on purpose
        await module.default({
          body: input,
          input,
          query: input,
          ctx,
        } as never);
        for (const query of seen) {
          const statement = pageStatement(query, { limit: 50 });
          const plan = (
            db.vault
              .prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
              .all(...(statement.bind as never[])) as Array<{ detail: string }>
          ).map((step) => step.detail);
          // Trailing whitespace is stripped: an absent WHERE leaves a blank
          // line with indentation on it, and the formatter would rewrite the
          // committed snapshot the moment it landed.
          const sql = statement.sql.replaceAll(/[ \t]+$/gmu, "");
          if (plans.some((held) => held.sql === sql)) continue;
          plans.push({
            handler: handler.name,
            name: query.name,
            sql,
            tables: tablesOf(query.from),
            plan,
          });
        }
      }
      captured.set(appId, plans);
    }
  }, 120_000);

  afterAll(() => {
    db.close();
  });

  test("the snapshot is the review diff for every statement that ran", async () => {
    const lines: string[] = [
      "<!-- Generated by app-query-plans.test.ts (#996 R8). Review the diff; do not hand-edit. -->",
      "",
      "# App query plans",
      "",
    ];
    for (const appId of APP_IDS) {
      lines.push(`## ${appId}`, "");
      const plans = captured.get(appId) ?? [];
      if (plans.length === 0) lines.push("_no paged statement ran_", "");
      for (const plan of plans) {
        lines.push(
          `### ${plan.name} (${appId}/${plan.handler})`,
          "",
          "```sql",
          plan.sql,
          "```",
          "",
          "```",
          ...plan.plan,
          "```",
          ""
        );
      }
    }
    await expect(lines.join("\n")).toMatchFileSnapshot(
      "./app-query-plans.snapshot.md"
    );
  });

  test.each(APP_IDS.map((appId) => [appId] as const))(
    "%s reads no table its manifest does not declare [law:app-entity-tripwire]",
    (appId) => {
      const scopes = manifestOf(appId).vault.scopes;
      const undeclared = [
        ...new Set(
          (captured.get(appId) ?? []).flatMap((plan) =>
            plan.tables.filter((table) => !declaresTable(scopes, table))
          )
        ),
      ];
      expect(undeclared, `${appId} reads what it never declared`).toStrictEqual(
        []
      );
    }
  );

  test.each(APP_IDS.map((appId) => [appId] as const))(
    "%s issued at least one paged statement to plan",
    (appId) => {
      // A handler that reached no statement contributes no review diff, so an
      // app that silently stopped paging would leave this file smaller and
      // nothing else would say so.
      expect(captured.get(appId) ?? []).not.toStrictEqual([]);
    }
  );
});
