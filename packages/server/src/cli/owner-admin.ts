import { EnrollmentStore } from "../serve/enrollment-store.js";
import { GatewayDatabase, GatewayLockError } from "../serve/gateway-db.js";
import { OwnerRemovalError, OwnerStore } from "../serve/owner-store.js";

interface OwnerArgs {
  dataDir?: string;
  label?: string;
  positional: string[];
}

function parseOwnerArgs(
  args: string[],
  fail: (msg: string, code?: number) => never
): OwnerArgs {
  const out: OwnerArgs = { positional: [] };
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
      default:
        if (flag.startsWith("--")) fail(`unknown flag "${flag}"`, 2);
        out.positional.push(flag);
    }
  }
  return out;
}

export function commandOwners(
  args: string[],
  fail: (msg: string, code?: number) => never
): void {
  const [action, ...rest] = args;
  if (!action || !["list", "add", "rename", "remove"].includes(action)) {
    fail("owners subcommand must be one of: list, add, rename, remove", 2);
  }
  const parsed = parseOwnerArgs(rest, fail);
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
          ? "the running daemon owns the owner registry — query its owners route instead"
          : error.message,
        1
      );
    }
    throw error;
  }
  const owners = OwnerStore.open(database);
  const enrollments = EnrollmentStore.open(database);

  try {
    if (action === "list") {
      for (const owner of owners.list()) {
        const devices = enrollments
          .list()
          .filter((row) => row.ownerId === owner.ownerId);
        process.stdout.write(
          `${JSON.stringify({
            ...owner,
            vaults: owners.vaultsOwnedBy(owner.ownerId),
            devices: [...new Set(devices.map((row) => row.endpointId))],
          })}\n`
        );
      }
      return;
    }

    if (action === "add") {
      const label = parsed.label ?? parsed.positional[0];
      if (!label) fail("usage: owners add --data-dir <path> <label>", 2);
      process.stdout.write(`${JSON.stringify(owners.create(label))}\n`);
      return;
    }

    const [selector] = parsed.positional;
    if (!selector) {
      fail(
        `usage: owners ${action} --data-dir <path> <owner-id-or-label> …`,
        2
      );
    }
    const owner = owners.find(selector);
    if (!owner) fail(`no owner matches "${selector}"`, 1);

    if (action === "rename") {
      const label = parsed.label ?? parsed.positional[1];
      if (!label) {
        fail(
          "usage: owners rename --data-dir <path> <owner-id-or-label> --label <new-label>",
          2
        );
      }
      process.stdout.write(
        `${JSON.stringify(owners.rename(owner.ownerId, label))}\n`
      );
      return;
    }

    try {
      const removed = enrollments.removeOwner(owner.ownerId);
      process.stdout.write(
        `${JSON.stringify({
          removed: owner,
          devices: [...new Set(removed.map((row) => row.endpointId))],
        })}\n`
      );
    } catch (error) {
      if (error instanceof OwnerRemovalError) {
        fail(
          `removing ${JSON.stringify(owner.label)} is refused: they still own ` +
            `vault${error.ownedVaultIds.length === 1 ? "" : "s"} ${error.ownedVaultIds.join(", ")}. ` +
            "Erase those vaults first — a removed person must never orphan a vault.",
          1
        );
      }
      throw error;
    }
  } finally {
    database.close();
  }
}
