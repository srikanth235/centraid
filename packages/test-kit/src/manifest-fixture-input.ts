/**
 * ONE FIXTURE INPUT PER MANIFESTED HANDLER, DERIVED FROM ITS OWN SCHEMA.
 *
 * A handler's manifest declares the shape of what it takes; this builds the
 * smallest value of that shape, so a suite can invoke every shipped handler
 * without a hand-written input per handler going stale beside the schema.
 *
 * It is shared by the two suites that have to invoke the whole set — the
 * behavioural contract
 * (`packages/blueprints/src/handler-crud-smoke.integration.test.ts`) and the
 * committed query-plan review diff
 * (`packages/server/src/serve/app-query-plans.test.ts`) — which is why it
 * lives in the kit rather than in either: they are different packages, and
 * only one of them can reach a real vault.
 *
 * The strings are DELIBERATELY plausible rather than random: a handler that
 * parses a date, a data URI or a hash gets one it can parse, because the point
 * is to reach the handler's read, not to fuzz its argument checking.
 */

export interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  minimum?: number;
  minLength?: number;
  pattern?: string;
}

function stringFixture(name: string, schema: JsonSchema): string {
  if (schema.enum?.length) return String(schema.enum[0]);
  if (name === "data_uri") return "data:text/plain;base64,c2VlZC1maXh0dXJl";
  if (name === "staged_sha") return "a".repeat(64);
  if (name === "phash") return "0f0f";
  if (name === "thumbhash") return "AAAAAA";
  if (name.includes("origin")) return "https://example.test";
  if (name.includes("uri") || name === "url")
    return "https://example.test/seed";
  if (name === "rrule") return "FREQ=DAILY;COUNT=2";
  if (
    name.includes("_at") ||
    name === "from" ||
    name === "to" ||
    name.includes("date")
  )
    return "2026-07-29T09:00:00.000Z";
  if (name === "spent_on") return "2026-07-29";
  return `seed-${name}`.padEnd(schema.minLength ?? 1, "x");
}

/** The smallest value the schema admits; `undefined` schema means a string. */
export function schemaFixture(
  schema: JsonSchema = {},
  name = "value"
): unknown {
  if (schema.enum?.length) return schema.enum[0];
  const type = Array.isArray(schema.type)
    ? (schema.type.find((candidate) => candidate !== "null") ?? "null")
    : schema.type;
  switch (type) {
    case undefined:
      return stringFixture(name, schema);
    case "array":
      return [schemaFixture(schema.items, `${name}_item`)];
    case "boolean":
      return true;
    case "integer":
      return Math.max(1, schema.minimum ?? 1);
    case "number":
      return Math.max(1, schema.minimum ?? 1);
    case "object":
      return Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([key, property]) => [
          key,
          schemaFixture(property, key),
        ])
      );
    case "null":
      return null;
    default:
      return stringFixture(name, schema);
  }
}
