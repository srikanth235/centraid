// The two blocks the Backup screen's numbers live in (#712) — the gateway's
// CUSTODY ROLLUP, and the free-up OFFER derived from one bucket of it.
//
// Separate from `BackupHealth.tsx` because they are the half of that screen
// that speaks for the GATEWAY. The screen proper speaks for this phone: the durable
// upload queue, the transfer policy, the consent latch. Two sources, two
// voices, and the split makes it hard to accidentally print one's number under
// the other's heading.
//
// EVERY NUMBER HERE CAME OFF `blob.custody_rollup`. Nothing on these blocks is
// derived from what the phone happens to have cached, and an unrun sweep says
// so rather than rendering zeroes — see `custody-status.ts` for why null is
// carried all the way from the vault projection to this file.

import React from "react";
import { Pressable, View } from "react-native";

import { formatBytes } from "@centraid/design";

import { Text } from "../kit/components/NativeText";
import type {
  CustodyBucket,
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

/**
 * WHICH APPS A FREE-UP PASS MAY RELEASE ORIGINALS FOR (#712).
 *
 * The list lives HERE, in the caller, and not inside `kit/storage` — that
 * module enumerates no apps on purpose, so nothing can be opted in by a
 * registry nobody reads. Two structural exclusions:
 *
 *   * LOCKER is absent because the bytes ARE the secret. There is no preview
 *     to fall back to, so releasing the local copy is not a degradation, it is
 *     losing the thing (docs/blueprint-seats.md, and the A7 ruling that keeps
 *     `locker.item` unrepresentable in the placement registry for the same
 *     reason).
 *   * RECORD-ONLY apps (Tasks, People, Notes bodies, Tally, Agenda) are absent
 *     because they hold no originals at all — the seat table calls free-up
 *     "meaningless" for them, and offering it would be a control over nothing.
 */
export const FREE_UP_APPS: readonly string[] = ["photos", "docs"];

/** The rollup buckets this screen prints, worst last — a reader scanning down
 *  ends on the thing that needs them, not on the thing that is fine. */
const CUSTODY_ROWS: ReadonlyArray<{
  bucket: CustodyBucket;
  label: string;
  sub: string;
  net?: true;
}> = [
  {
    bucket: "replicated",
    label: "Backed up",
    sub: "on your vault's home machine and off it — nothing more to do for these",
  },
  {
    bucket: "remote-only",
    label: "Held elsewhere",
    sub: "on the remote tier only; this machine let its copy go",
  },
  {
    bucket: "pending-offsite",
    label: "Waiting to leave",
    sub: "queued for the remote tier; nothing wrong yet",
  },
  {
    bucket: "local-only",
    label: "Not backed up",
    sub: "on your vault's home machine and nowhere else",
    net: true,
  },
  {
    bucket: "missing",
    label: "Missing",
    sub: "in neither tier — an integrity gap, never a rounding error",
    net: true,
  },
];

/**
 * The rollup, or the honest reason there is none. Every count and every byte
 * here came off `blob.custody_rollup`; nothing on this block is derived from
 * what the phone happens to have cached.
 */
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
  return (
    <>
      {CUSTODY_ROWS.map((row) => {
        const totals = custody.buckets[row.bucket];
        return (
          <View
            key={row.bucket}
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
      <Text style={[styles.note, { color: colors.textFaint }]}>
        Counted {formatSyncTime(custody.computedAt)}
        {custody.uncounted.length > 0
          ? ` · not counted: ${custody.uncounted.join(", ")}`
          : ""}
      </Text>
    </>
  );
}

/** Cause, consequence, one action — and never an offer to release bytes the
 *  rollup has not proven are held somewhere else. */
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
        {/* Outlined, never filled — "Back up now" above is the one commit on
            this surface (§18). Releasing bytes is reached from the app that
            owns them, where the per-copy revalidation runs
            (`kit/storage/free-up-space.ts`'s `revalidateBackedUp`, wired in
            `apps/photos/PhotosLibrary.tsx`): this frame surface states the
            offer and its size, and never deletes a device original itself. */}
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

/**
 * Why the control on THIS screen does not delete anything. The frame can prove
 * how much is releasable — that is what the rollup is for — but the second
 * gate, re-hashing each device copy before it is deleted, needs the app that
 * holds the copies. Saying so beats a button that silently does less than its
 * label.
 */
const FREE_UP_WHERE =
  "Release the copies from the app that holds them — Photos re-hashes each device original before deleting it.";

/** Shared with the screen's header, which prints the last successful sync in
 *  the same register. Local to this pair of files by design: a date format is
 *  a rendering choice, not a fact the kit should own. */
export function formatSyncTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp)
    ? "Unknown"
    : new Date(timestamp).toLocaleString();
}
