// Backup screen's gateway numbers (#712): custody rollup + free-up offer. Phone-side lives in BackupHealth.tsx.

import React from "react";
import { Pressable, View } from "react-native";

import { formatBytes } from "@centraid/design";

import { Text } from "../kit/components/NativeText";
import { custodyDurability } from "../kit/storage/custody-status";
import type {
  CustodyDurability,
  CustodyStatus,
} from "../kit/storage/custody-status";
import {
  FREE_UP_ACTION,
  FREE_UP_CAUSE,
  FREE_UP_CONSEQUENCE,
  FREE_UP_NOTHING,
  FREE_UP_UNCOUNTED,
} from "../kit/storage/free-up-space";
import type { FreeUpOffer } from "../kit/storage/free-up-space";
import { useTheme } from "../kit/theme";
import { styles } from "./BackupHealth.styles";

// Locker and record-only apps are absent: locker bytes ARE the secret; record-only hold no originals.
export const FREE_UP_APPS: readonly string[] = ["photos", "docs"];

/**
 * TWO STATES AND A CACHE BIT (#996, R7). This was five rows, one per custody
 * state, and a member reading them had to work out which of "on the home
 * machine and off it", "on the remote tier only", "queued for the remote tier"
 * and "on the home machine and nowhere else" meant their photograph was safe.
 * All four mean the gateway's CAS holds it; only `missing` does not.
 */
const CUSTODY_ROWS: ReadonlyArray<{
  key: keyof CustodyDurability;
  label: string;
  sub: string;
  net?: true;
}> = [
  {
    key: "backedUp",
    label: "Backed up",
    sub: "your vault holds these, verified — nothing more to do for them",
  },
  {
    key: "notBackedUp",
    label: "Not backed up",
    sub: "in neither tier — an integrity gap, never a rounding error",
    net: true,
  },
];

export function CustodyBlock({
  custody,
  online,
}: {
  custody: CustodyStatus | null | undefined;
  online?: boolean;
}): React.JSX.Element {
  const { colors } = useTheme();
  if (custody === null)
    return (
      <Text style={[styles.note, { color: colors.textSoft }]}>
        Your vault&apos;s storage status could not be read.
      </Text>
    );
  if (custody === undefined)
    return (
      <Text style={[styles.note, { color: colors.textSoft }]}>
        {online
          ? "Reading your vault's storage status…"
          : "Offline — your vault's storage status is not readable from here."}
      </Text>
    );
  if (custody.computedAt === null)
    return (
      <Text style={[styles.note, { color: colors.textSoft }]}>
        {FREE_UP_UNCOUNTED}
      </Text>
    );
  const durability = custodyDurability(custody);
  return (
    <>
      {CUSTODY_ROWS.map((row) => {
        const totals = durability[row.key];
        return (
          <View
            key={row.key}
            style={[
              styles.fact,
              { borderBottomColor: colors.line },
              row.net && totals.count > 0
                ? { borderLeftColor: colors.net, ...styles.factFlagged }
                : null,
            ]}
          >
            <Text style={[styles.factLabel, { color: colors.textSoft }]}>
              {row.label} · {totals.count} · {formatBytes(totals.bytes)}
            </Text>
            <Text
              style={[
                styles.factValue,
                {
                  color:
                    row.net && totals.count > 0 ? colors.net : colors.textSoft,
                },
              ]}
            >
              {row.sub}
            </Text>
          </View>
        );
      })}
      {/* The cache bit, said as a bit and not as a state: it answers "what
          could this vault let go", never "what is at risk". */}
      <Text style={[styles.note, { color: colors.textFaint }]}>
        {durability.releasable.count > 0
          ? `${durability.releasable.count} of them are cached copies this vault could release · ${formatBytes(durability.releasable.bytes)}`
          : "No cached copies are releasable right now."}
      </Text>
      <Text style={[styles.note, { color: colors.textFaint }]}>
        Counted {formatSyncTime(custody.computedAt)}
        {custody.uncounted.length > 0
          ? ` · not counted: ${custody.uncounted.join(", ")}`
          : ""}
      </Text>
    </>
  );
}

export function FreeUpBlock({
  offer,
}: {
  offer: FreeUpOffer | null;
}): React.JSX.Element | null {
  const { colors } = useTheme();
  if (!offer) return null;
  if (offer.kind !== "offer")
    return (
      <Text style={[styles.note, { color: colors.textSoft }]}>
        {offer.kind === "uncounted" ? FREE_UP_UNCOUNTED : FREE_UP_NOTHING}
      </Text>
    );
  return (
    <View
      style={[
        styles.panel,
        { backgroundColor: colors.bgElev, borderColor: colors.line },
      ]}
    >
      <Text style={[styles.panelTitle, { color: colors.text }]}>
        {offer.totals.count} originals · {formatBytes(offer.totals.bytes)}{" "}
        releasable
      </Text>
      <Text style={[styles.body, { color: colors.textSoft }]}>
        {FREE_UP_CAUSE}
      </Text>
      <Text style={[styles.body, { color: colors.textSoft }]}>
        {FREE_UP_CONSEQUENCE}
      </Text>
      <View style={styles.actions}>
        {/* Outlined, never filled — this surface never deletes a device original. */}
        <Pressable
          accessibilityLabel={FREE_UP_ACTION}
          accessibilityRole="button"
          accessibilityState={{ disabled: true }}
          accessibilityHint={FREE_UP_WHERE}
          disabled
          style={[styles.action, { borderColor: colors.line }]}
        >
          <Text style={[styles.actionText, { color: colors.textDisabled }]}>
            {FREE_UP_ACTION}
          </Text>
        </Pressable>
      </View>
      <Text style={[styles.unavailable, { color: colors.textSoft }]}>
        {FREE_UP_WHERE}
      </Text>
    </View>
  );
}

const FREE_UP_WHERE =
  "Release the copies from the app that holds them — Photos re-hashes each device original before deleting it.";

export function formatSyncTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp)
    ? "Unknown"
    : new Date(timestamp).toLocaleString();
}
