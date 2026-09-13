// THE SCHEDULE CORPUS: one founded v0 vault, and the script both apps' parity
// fixtures are read from (#1020, wave 4 slot 4d).
//
// The two generators share this because they share the schema: Tasks reads
// `schedule_task`, Agenda reads `core_event` and `schedule_recurrence_exception`
// and `schedule_task` (the grid's due-work shelf), and both go through the SAME
// sixteen typed `schedule.*` commands. A second copy would be a second corpus,
// and the two apps' fixtures would stop describing one vault.

import { bootstrapVault } from "../../packages/vault/src/bootstrap.js";
import { registerAttachmentCommands } from "../../packages/vault/src/commands/attachments.js";
import { registerPartyCommands } from "../../packages/vault/src/commands/parties.js";
import { registerScheduleCommands } from "../../packages/vault/src/commands/schedule.js";
import { registerTagCommands } from "../../packages/vault/src/commands/tags.js";
import { registerTaskCommands } from "../../packages/vault/src/commands/tasks.js";
import { openVaultDb } from "../../packages/vault/src/db.js";
import { createGateway } from "../../packages/vault/src/gateway/gateway.js";
import type { Credential } from "../../packages/vault/src/gateway/types.js";
import { installFixtureClock } from "../../packages/vault/tests/fixtures/ontology-scenarios/clock.js";
import { PARITY_EPOCH, loadCtxTime } from "./schedule-parity-bundle.js";
import type { CommandStep } from "./schedule-parity-bundle.js";

/** What a corpus run hands its caller. */
export interface Corpus {
  db: ReturnType<typeof openVaultDb>;
  gateway: ReturnType<typeof createGateway>;
  owner: Credential;
  ownerPartyId: string;
  calendarId: string;
  clock: ReturnType<typeof installFixtureClock>;
  commands: CommandStep[];
  /** Run one command and record it as a REPLAYABLE step. */
  execute: <T extends Record<string, unknown>>(
    command: string,
    input: Record<string, unknown>,
    outputKeys?: string[],
    expect?: "executed" | "any"
  ) => T;
  /** The handler context, `vault` and `time`. */
  ctx: Record<string, unknown>;
  close: () => void;
}

/**
 * Found a vault, register the command packs both apps reach, and hand back a
 * recorder.
 *
 * The packs: `schedule.*` (all sixteen, through
 * `registerScheduleCommands`, which also registers the organize and project
 * halves), `schedule.add_task` and its four siblings through
 * `registerTaskCommands`, plus `core.*`'s party, tag and attachment packs,
 * because Tasks' `add-tag` and both apps' `attach` are `core.*` actions.
 */
export async function openCorpus(): Promise<Corpus> {
  const db = openVaultDb();
  const clock = installFixtureClock(PARITY_EPOCH);
  const boot = bootstrapVault(db, { ownerName: "Priya", baseCurrency: "GBP" });
  const gateway = createGateway(db);
  registerScheduleCommands(gateway);
  registerTaskCommands(gateway);
  registerPartyCommands(gateway);
  registerTagCommands(gateway);
  registerAttachmentCommands(gateway);
  const owner: Credential = {
    kind: "device",
    deviceId: boot.deviceId,
    deviceKey: boot.deviceKey,
  };
  // Events need a calendar and no command mints one — `bootstrapVault` seeds a
  // private "Personal" calendar so the schema works out of the box
  // (`bootstrap.ts:150`-`:155`). Discover it; never hardcode the id.
  const calendar = db.vault
    .prepare(
      "SELECT calendar_id FROM schedule_calendar ORDER BY calendar_id LIMIT 1"
    )
    .get() as { calendar_id: string } | undefined;
  if (!calendar) throw new Error("the founded vault has no calendar");

  let step = 0;
  const outputs: Record<string, unknown>[] = [];
  const commands: CommandStep[] = [];
  const execute = <T extends Record<string, unknown>>(
    command: string,
    input: Record<string, unknown>,
    outputKeys: string[] = [],
    expect: "executed" | "any" = "executed"
  ): T => {
    // THE RESOLVER WALKS ARRAYS TOO. `attendee_party_ids: [{"$from": …}]` is
    // a reference inside a list, and a top-level-only resolver leaves the
    // object in the payload, where the command's input schema refuses it —
    // which is what a fixture that silently skipped a step would look like.
    const resolveValue = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(resolveValue);
      if (value && typeof value === "object") {
        if ("$from" in value) {
          const reference = (value as { $from: string }).$from;
          const [at, field] = reference.split(".");
          const produced = outputs[Number(at)]?.[field ?? ""];
          if (produced === undefined) {
            throw new Error(`step ${at} produced no \`${field}\``);
          }
          return produced;
        }
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(
            ([key, child]) => [key, resolveValue(child)]
          )
        );
      }
      return value;
    };
    const resolved = resolveValue(input) as Record<string, unknown>;
    const outcome = gateway.invoke(
      owner,
      { command, input: resolved },
      `schedule-parity:${step++}`
    );
    const reason =
      (outcome as { reason?: string; message?: string }).reason ??
      (outcome as { message?: string }).message;
    // EVERY case is recorded, refusals included: a refusal is an answer the
    // port has to reproduce, and the ones this fixture trips on purpose are
    // the cases a port gets wrong.
    commands.push({
      command,
      input,
      output_keys: outputKeys,
      status: outcome.status,
      ...(reason === undefined ? {} : { reason }),
    });
    if (expect === "executed" && outcome.status !== "executed") {
      throw new Error(
        `${command} answered ${outcome.status}: ${reason ?? "no reason given"}`
      );
    }
    outputs.push(
      ((outcome as { output?: Record<string, unknown> }).output ??
        {}) as Record<string, unknown>
    );
    // Time moves between commands, or two writes share an instant and every
    // ordering claim over them says nothing.
    clock.advance(1_000);
    return (outcome as { output?: T }).output as T;
  };

  const time = await loadCtxTime();
  const ctx = {
    vault: {
      page: (request: {
        query: Parameters<typeof gateway.page>[1];
        limit: number;
        after?: { sortKey: string; pk: string };
      }) =>
        Promise.resolve(
          gateway.page(owner, request.query, {
            limit: request.limit,
            ...(request.after ? { after: request.after } : {}),
          })
        ),
      invoke: (request: { command: string; input?: Record<string, unknown> }) =>
        Promise.resolve(
          gateway.invoke(owner, {
            command: request.command,
            input: request.input ?? {},
          })
        ),
      search: (request: { entity: string; query: string; limit: number }) =>
        Promise.resolve(gateway.search(owner, request)),
      // NO `resolve`. The entity-card resolver is the gateway's own and this
      // corpus carries no cross-references from a task, so the board never
      // reaches for it — and a stub that answered would put a card in the
      // fixture that no port can produce.
    },
    time,
  };

  return {
    db,
    gateway,
    owner,
    ownerPartyId: boot.ownerPartyId,
    calendarId: calendar.calendar_id,
    clock,
    commands,
    execute,
    ctx,
    close: () => {
      clock.restore();
      db.close();
    },
  };
}
