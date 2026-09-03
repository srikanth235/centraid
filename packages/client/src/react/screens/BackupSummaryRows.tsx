import type { JSX } from "react";

import { formatDuration } from "../shell/routes/gatewayData.js";
import RowsBlock from "../ui/RowsBlock.js";
import type { RowDef } from "../ui/RowsBlock.js";
import type { BackupStatusDTO } from "./BackupCard.js";

export interface BackupSummaryRowsProps {
  status: BackupStatusDTO;
  now: number;
  lastRunAt: number | null;
  onRunNow?: () => void;
  running?: boolean;
  onOpenSettings?: () => void;
}

function policyPhrase(status: BackupStatusDTO): string {
  const policies = status.vaults.flatMap((vault) =>
    vault.policy ? [vault.policy] : []
  );
  const first = policies[0];
  if (first === undefined) return "not set — the gateway's defaults apply";
  const snapshot =
    first.snapshotIntervalHours >= 24
      ? `${Math.round(first.snapshotIntervalHours / 24)} day${first.snapshotIntervalHours >= 48 ? "s" : ""}`
      : `${first.snapshotIntervalHours} hour${first.snapshotIntervalHours === 1 ? "" : "s"}`;
  return `a snapshot every ${snapshot} · verified every ${first.verifyEveryDays} day${
    first.verifyEveryDays === 1 ? "" : "s"
  }`;
}

function cadenceWord(status: BackupStatusDTO): string {
  const hours = status.vaults[0]?.policy?.snapshotIntervalHours;
  if (hours === undefined) return "default";
  if (hours <= 1) return "hourly";
  if (hours < 24) return `every ${hours}h`;
  if (hours === 24) return "daily";
  return `every ${Math.round(hours / 24)}d`;
}

function holders(status: BackupStatusDTO): { meta: string; sub: string } {
  const names = new Set<string>();
  let localOnly = false;
  for (const vault of status.vaults) {
    const kind = vault.destination?.kind ?? "gateway-local";
    if (kind === "provider" && status.provider) names.add(status.provider);
    else localOnly = true;
  }
  if (names.size === 0)
    return {
      meta: "0",
      sub: localOnly
        ? "this machine only — a copy on the disk it protects protects nothing"
        : "no destination is configured",
    };
  const list = [...names].join(" · ");
  return {
    meta: String(names.size),
    sub: localOnly ? `${list} · and this machine` : list,
  };
}

export default function BackupSummaryRows({
  status,
  now,
  lastRunAt,
  onRunNow,
  running,
  onOpenSettings,
}: BackupSummaryRowsProps): JSX.Element {
  const lastVerifyAt = status.vaults
    .map((vault) => (vault.lastVerifyAt ? Date.parse(vault.lastVerifyAt) : NaN))
    .filter((at) => Number.isFinite(at))
    .reduce<number | null>(
      (best, at) => (best === null || at > best ? at : best),
      null
    );
  const kitAt = status.recoveryKit?.confirmedAt ?? null;
  const who = holders(status);

  const rows: RowDef[] = [
    {
      id: "last-run",
      meta:
        lastRunAt === null
          ? "never"
          : lastVerifyAt === null
            ? "unverified"
            : "verified",
      sub:
        lastRunAt === null
          ? "nothing on this gateway has ever been copied off this machine"
          : lastVerifyAt === null
            ? "it ran, but no copy has been read back to prove it opens"
            : `verified ${formatDuration(Math.max(0, now - lastVerifyAt))} ago`,
      title:
        lastRunAt === null
          ? "No backup has ever run"
          : `Last backup ${formatDuration(Math.max(0, now - lastRunAt))} ago`,
      ...(lastRunAt === null || lastVerifyAt === null ? { net: true } : {}),
      ...(onRunNow
        ? {
            action: {
              hint: "Copy everything off this machine now",
              label: running ? "Backing up…" : "Back up now",
              onClick: onRunNow,
              ...(running ? { off: true } : {}),
            },
          }
        : {}),
    },
    {
      id: "policy",
      meta: cadenceWord(status),
      sub: policyPhrase(status),
      title: "Policy",
      ...(onOpenSettings
        ? {
            action: {
              hint: "Backup settings",
              label: "Change",
              onClick: onOpenSettings,
            },
          }
        : {}),
    },
    {
      id: "kit",
      meta: kitAt === null ? "not printed" : "printed",
      sub:
        kitAt === null
          ? "without it, an encrypted backup is a file nobody can read — including you"
          : `confirmed ${formatDuration(Math.max(0, now - kitAt * 1000))} ago · keep it off this machine`,
      title: "Recovery kit",
      ...(kitAt === null ? { net: true } : {}),
    },
    {
      id: "holders",
      meta: who.meta,
      sub: who.sub,
      title: "Who holds a copy",
      ...(who.meta === "0" ? { net: true } : {}),
    },
  ];

  return <RowsBlock ariaLabel="Backups" rows={rows} />;
}
