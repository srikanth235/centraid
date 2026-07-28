/*
 * `centraid-gateway members` — the household roster from the box itself
 * (issue #599 L2).
 *
 * Stopped-daemon filesystem maintenance, exactly like `devices`: mutations
 * take gateway.db's exclusive lock and refuse while the daemon is running,
 * because the running daemon owns that registry. This is the L0 host-custody
 * lane — the landlord on the box may author any membership, which is also the
 * only way back in once every admin device is gone.
 *
 * Removing a person is ONE operation here (their grants and every device
 * binding they own die together), never a loop over device rows.
 */

import { EnrollmentStore } from "../serve/enrollment-store.js";
import { GatewayDatabase, GatewayLockError } from "../serve/gateway-db.js";
import { MemberStore } from "../serve/member-store.js";

interface MemberArgs {
  dataDir?: string;
  label?: string;
  confirmLastAdmin?: string;
  positional: string[];
}

function parseMemberArgs(
  args: string[],
  fail: (msg: string, code?: number) => never
): MemberArgs {
  const out: MemberArgs = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === undefined) continue;
    const readValue = (): string => {
      const value = args[++i];
      if (value === undefined) fail(`flag "${flag}" requires a value`, 2);
      return value;
    };
    switch (flag) {
      case "--data-dir":
        out.dataDir = readValue();
        break;
      case "--label":
        out.label = readValue();
        break;
      case "--confirm-last-admin":
        out.confirmLastAdmin = readValue();
        break;
      default:
        if (flag.startsWith("--")) fail(`unknown flag "${flag}"`, 2);
        out.positional.push(flag);
    }
  }
  return out;
}

export function commandMembers(
  args: string[],
  fail: (msg: string, code?: number) => never
): void {
  const [action, ...rest] = args;
  if (!action || !["list", "add", "rename", "remove"].includes(action)) {
    fail("members subcommand must be one of: list, add, rename, remove", 2);
  }
  const parsed = parseMemberArgs(rest, fail);
  if (!parsed.dataDir) fail("--data-dir is required", 2);
  let database: GatewayDatabase;
  try {
    database = GatewayDatabase.open(parsed.dataDir, {
      lock: action === "list" ? "read-only" : "exclusive",
    });
  } catch (error) {
    if (error instanceof GatewayLockError) {
      fail(
        action === "list"
          ? "the running daemon owns the member registry — query its members route instead"
          : error.message,
        1
      );
    }
    throw error;
  }
  const members = MemberStore.open(database);
  const enrollments = EnrollmentStore.open(database);

  try {
    if (action === "list") {
      for (const member of members.list()) {
        const devices = enrollments
          .list()
          .filter((row) => row.memberId === member.memberId);
        process.stdout.write(
          `${JSON.stringify({
            ...member,
            roles: members.grants(member.memberId),
            devices: [...new Set(devices.map((row) => row.endpointId))],
          })}\n`
        );
      }
      return;
    }

    if (action === "add") {
      const label = parsed.label ?? parsed.positional[0];
      if (!label) fail("usage: members add --data-dir <path> <label>", 2);
      process.stdout.write(`${JSON.stringify(members.create(label))}\n`);
      return;
    }

    const [selector] = parsed.positional;
    if (!selector) {
      fail(
        `usage: members ${action} --data-dir <path> <member-id-or-label> …`,
        2
      );
    }
    const member = members.find(selector);
    if (!member) fail(`no member matches "${selector}"`, 1);

    if (action === "rename") {
      const label = parsed.label ?? parsed.positional[1];
      if (!label) {
        fail(
          "usage: members rename --data-dir <path> <member-id-or-label> --label <new-label>",
          2
        );
      }
      // Renaming keeps the id, so every binding, grant, and prior journal
      // attribution follows the person rather than the label.
      process.stdout.write(
        `${JSON.stringify(members.rename(member.memberId, label))}\n`
      );
      return;
    }

    const orphaned = members.vaultsLosingLastAdmin(member.memberId);
    const firstOrphaned = orphaned[0];
    if (
      firstOrphaned !== undefined &&
      parsed.confirmLastAdmin !== firstOrphaned
    ) {
      fail(
        `removing ${JSON.stringify(member.label)} leaves vault ${firstOrphaned} with no admin member; ` +
          `pass --confirm-last-admin ${firstOrphaned}. Recovery then requires filesystem access ` +
          "and `centraid-gateway devices add`.",
        1
      );
    }
    const removed = members.remove(member.memberId);
    process.stdout.write(
      `${JSON.stringify({ removed: member, devices: removed.removedEndpointIds, vaults: removed.removedVaultIds })}\n`
    );
  } finally {
    database.close();
  }
}
