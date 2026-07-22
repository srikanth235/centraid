/*
 * Prepared-statement builders for InsightsStore (#514).
 */

import { type DatabaseSync, type StatementSync } from 'node:sqlite';

const TOKEN_SUM = `(COALESCE(total_input_tokens,0)+COALESCE(total_output_tokens,0)
  +COALESCE(total_cache_read_tokens,0)+COALESCE(total_cache_write_tokens,0))`;

/** Finished run with no token fields reported (all NULL/0). */
const UNREPORTED_PRED = `${TOKEN_SUM} = 0`;

export { TOKEN_SUM };

export interface InsightsPreparedStatements {
  kpis: StatementSync;
  costSplit: StatementSync;
  appsTouched: StatementSync;
  daily: StatementSync;
  bySource: StatementSync;
  byRunner: StatementSync;
  byModel: StatementSync;
  recent: StatementSync;
  daySources: StatementSync;
  kpisDigest: StatementSync;
  appsTouchedDigest: StatementSync;
  dailyDigest: StatementSync;
  bySourceDigest: StatementSync;
  byModelDigest: StatementSync;
}

export function prepareInsightsStatements(db: DatabaseSync): InsightsPreparedStatements {
  return {
    kpis: db.prepare(`
        SELECT
          COUNT(*) AS generations,
          SUM(CASE WHEN retry_of IS NOT NULL THEN 1 ELSE 0 END) AS retries,
          SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN ok = 0 THEN COALESCE(total_cost_usd, 0) ELSE 0 END) AS failed_cost,
          SUM(${TOKEN_SUM}) AS tokens,
          SUM(COALESCE(total_cost_usd, 0)) AS cost,
          SUM(CASE WHEN total_cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced,
          SUM(CASE WHEN ${UNREPORTED_PRED} THEN 1 ELSE 0 END) AS unreported
        FROM run_summary
        WHERE started_at >= ?
      `),
    costSplit: db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN i.cost_source = 'agent' THEN i.cost_usd ELSE 0 END), 0) AS agent_cost,
          COALESCE(SUM(CASE
            WHEN i.cost_source = 'estimated' THEN i.cost_usd
            WHEN i.cost_source IS NULL AND i.cost_usd IS NOT NULL THEN i.cost_usd
            ELSE 0
          END), 0) AS estimated_cost
        FROM items i
        JOIN turns t ON t.id = i.turn_id
        WHERE t.ended_at IS NOT NULL AND t.started_at >= ?
          AND i.kind IN ('step','agent')
      `),
    appsTouched: db.prepare(`
        SELECT DISTINCT app_id AS app_id
        FROM run_summary
        WHERE started_at >= ? AND app_id IS NOT NULL
      `),
    daily: db.prepare(`
        SELECT
          date(started_at / 1000, 'unixepoch') AS day,
          SUM(${TOKEN_SUM}) AS tokens,
          SUM(COALESCE(total_cost_usd, 0)) AS cost,
          COUNT(*) AS runs
        FROM run_summary
        WHERE started_at >= ?
        GROUP BY day ORDER BY day ASC
      `),
    bySource: db.prepare(`
        SELECT
          kind AS kind,
          automation_ref AS automation_ref,
          MAX(automation_name) AS name,
          COUNT(*) AS runs,
          SUM(${TOKEN_SUM}) AS tokens,
          SUM(COALESCE(total_cost_usd, 0)) AS cost
        FROM run_summary
        WHERE started_at >= ?
        GROUP BY kind, automation_ref
        ORDER BY cost DESC, tokens DESC
      `),
    byRunner: db.prepare(`
        SELECT
          COALESCE(provider, 'unknown') AS provider,
          COUNT(*) AS runs,
          SUM(${TOKEN_SUM}) AS tokens,
          SUM(COALESCE(total_cost_usd, 0)) AS cost
        FROM run_summary
        WHERE started_at >= ?
        GROUP BY COALESCE(provider, 'unknown')
        ORDER BY cost DESC, tokens DESC
      `),
    byModel: db.prepare(`
        SELECT
          model AS model,
          COUNT(*) AS runs,
          SUM(${TOKEN_SUM}) AS tokens,
          SUM(COALESCE(total_cost_usd, 0)) AS cost
        FROM run_summary
        WHERE started_at >= ? AND model IS NOT NULL
        GROUP BY model ORDER BY cost DESC, tokens DESC
      `),
    recent: db.prepare(`
        SELECT
          run_id AS id, kind AS kind, ok AS ok, started_at AS started_at,
          summary AS summary, note AS note, automation_name AS name,
          automation_ref AS automation_ref,
          model AS model, provider AS provider,
          ${TOKEN_SUM} AS tokens, COALESCE(total_cost_usd, 0) AS cost
        FROM run_summary
        WHERE started_at >= ?
        ORDER BY
          CASE WHEN ok = 0 THEN 0 ELSE 1 END,
          COALESCE(total_cost_usd, 0) DESC,
          started_at DESC
        LIMIT ?
      `),
    daySources: db.prepare(`
        SELECT
          kind AS kind,
          automation_ref AS automation_ref,
          MAX(automation_name) AS name,
          SUM(${TOKEN_SUM}) AS tokens,
          SUM(COALESCE(total_cost_usd, 0)) AS cost
        FROM run_summary
        WHERE started_at >= ? AND started_at < ?
          AND date(started_at / 1000, 'unixepoch') = ?
        GROUP BY kind, automation_ref
        ORDER BY cost DESC, tokens DESC
        LIMIT 5
      `),
    kpisDigest: db.prepare(`
        SELECT
          COALESCE(SUM(run_count), 0) AS generations,
          COALESCE(SUM(retry_count), 0) AS retries,
          COALESCE(SUM(${TOKEN_SUM}), 0) AS tokens,
          COALESCE(SUM(total_cost_usd), 0) AS cost
        FROM conversation_digest
        WHERE last_ended_at IS NOT NULL AND last_ended_at >= ?
      `),
    appsTouchedDigest: db.prepare(`
        SELECT DISTINCT app_id AS app_id
        FROM conversation_digest
        WHERE last_ended_at IS NOT NULL AND last_ended_at >= ? AND app_id IS NOT NULL
      `),
    dailyDigest: db.prepare(`
        SELECT
          date(last_ended_at / 1000, 'unixepoch') AS day,
          ${TOKEN_SUM} AS tokens,
          COALESCE(total_cost_usd, 0) AS cost,
          run_count AS runs
        FROM conversation_digest
        WHERE last_ended_at IS NOT NULL AND last_ended_at >= ?
      `),
    bySourceDigest: db.prepare(`
        SELECT
          kind AS kind,
          automation_ref AS automation_ref,
          automation_name AS name,
          run_count AS runs,
          ${TOKEN_SUM} AS tokens,
          COALESCE(total_cost_usd, 0) AS cost
        FROM conversation_digest
        WHERE last_ended_at IS NOT NULL AND last_ended_at >= ?
      `),
    byModelDigest: db.prepare(`
        SELECT
          json_extract(m.value, '$.model') AS model,
          COALESCE(json_extract(m.value, '$.runs'), 0) AS runs,
          COALESCE(json_extract(m.value, '$.tokens'), 0) AS tokens,
          COALESCE(json_extract(m.value, '$.cost'), 0) AS cost
        FROM conversation_digest d, json_each(d.models_json) m
        WHERE d.last_ended_at IS NOT NULL AND d.last_ended_at >= ?
          AND json_extract(m.value, '$.model') IS NOT NULL
      `),
  };
}
