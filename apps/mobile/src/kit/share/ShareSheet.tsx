// ONE share sheet (issue #726 P6) — the native half; `packages/blueprints/
// apps/_shared/ShareSheet.tsx` is the web one. A give/lend toggle over ONE
// destination list: the member's own other writable vaults AND every linked
// person, mixed, never sorted or labelled by where a destination physically
// lives (D3).
//
// REPLACES `kit/share/CopyToVaultPicker.tsx` (the P0 sole-destination copy
// picker) AND `kit/components/AudiencePlacementSheet.tsx` (the P0 collection-
// level share sheet) — both did the same job this one does, for two
// different callers, neither aware of linked people or lending. Both are
// deleted; every former caller is rewired to this file.
import * as Crypto from "expo-crypto";
import React, { useEffect, useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";

import type { PlaceableItemType } from "@centraid/blueprints/apps/_shared/placement-registry";

import { listLinks } from "../../lib/replica/links-transport";
import type { LendScopeInput } from "../../lib/replica/placement-transport";
import { Text } from "../components/NativeText";
import TopSafeArea from "../components/TopSafeArea";
import { useReplica } from "../replica/ReplicaProvider";
import { borders, radii, spacing, t, useTheme } from "../theme";

export type ShareVerb = "give" | "lend";

/** Best-effort human label for a linked vault id — a vault that has already
 *  lent something IN carries its own label; one that has not is a genuine
 *  wire gap (no route names a linked-but-never-shared-with vault yet). */
function destinationLabel(
  vaultId: string,
  scopes: readonly { vaultId: string; label: string; borrowed?: unknown }[]
): string {
  const known = scopes.find((s) => s.vaultId === vaultId && s.borrowed);
  if (known) return known.label;
  return `Linked vault ${vaultId.length > 10 ? `${vaultId.slice(0, 8)}…` : vaultId}`;
}

export interface ShareSheetProps {
  visible: boolean;
  onClose: () => void;
  sourceVaultId: string;
  /** What the sheet is sharing, for its own title copy ("Share ⟨noun⟩"). */
  noun: string;
  verbs: readonly ShareVerb[];
  /** What a GIVE copies. Ignored when `verbs` excludes `"give"`. */
  itemType?: PlaceableItemType;
  itemIds?: readonly string[];
  /** Batch-give override — e.g. Photos' selection bar routing through its
   *  own tested batch write instead of N sequential `place()` calls. Absent
   *  falls back to a per-item `session.place()` loop. */
  giveMany?: (destination: {
    vaultId: string;
    label: string;
  }) => Promise<{ ok: boolean; message: string }>;
  /** What a LEND opens a window over, and the human name its note uses.
   *  Ignored when `verbs` excludes `"lend"`. */
  mintedIdFamilies?: readonly string[];
  appLabel?: string;
  onDone: (outcome: { verb: ShareVerb; ok: boolean; message: string }) => void;
}

function wholeLibraryLendScope(
  mintedIdFamilies: readonly string[]
): LendScopeInput[] {
  const [schema, table] = (mintedIdFamilies[0] ?? "").split(".");
  return schema && table ? [{ schema, table }] : [];
}

export default function ShareSheet({
  visible,
  onClose,
  sourceVaultId,
  noun,
  verbs,
  itemType,
  itemIds,
  giveMany,
  mintedIdFamilies,
  appLabel,
  onDone,
}: ShareSheetProps): React.JSX.Element {
  const { colors } = useTheme();
  const replica = useReplica();
  const [verb, setVerb] = useState<ShareVerb>(verbs[0] ?? "give");
  const [linkDestinations, setLinkDestinations] = useState<
    { vaultId: string; label: string }[]
  >([]);
  const [busy, setBusy] = useState(false);
  // A GIVE is irrevocable the instant it lands (D7) — this is the confirm
  // step that warns BEFORE it fires, never after. A LEND needs none: it is
  // revocable at any time ("stop lending"), so a single tap is honest.
  const [confirming, setConfirming] = useState<{
    vaultId: string;
    label: string;
  } | null>(null);

  // The sheet should re-fetch link destinations only when it (re)opens,
  // never on every scope/verb/gateway identity change while it's already
  // showing — so the effect below reads the LATEST values through this ref
  // instead of declaring them as dependencies. The ref is synced in its own
  // effect (never written during render) and declared first so it's current
  // by the time the visible-triggered effect below runs in the same commit.
  const openInputsRef = useRef({
    verbs,
    sourceVaultId,
    gatewayBase: replica.gatewayBase,
    scopes: replica.scopes,
  });
  useEffect(() => {
    openInputsRef.current = {
      verbs,
      sourceVaultId,
      gatewayBase: replica.gatewayBase,
      scopes: replica.scopes,
    };
  });

  useEffect(() => {
    if (!visible) return;
    const {
      verbs: openVerbs,
      sourceVaultId: openSourceVaultId,
      gatewayBase: base,
      scopes: openScopes,
    } = openInputsRef.current;
    setVerb(openVerbs[0] ?? "give");
    setBusy(false);
    setConfirming(null);
    let live = true;
    if (!base) return;
    const scopes = openScopes ?? [];
    listLinks(base)
      .then((links) => {
        if (!live) return;
        const mounted = new Set(scopes.map((s) => s.vaultId));
        setLinkDestinations(
          links
            .filter((link) => link.approved && !link.revoked)
            .map((link) =>
              link.vaultA === openSourceVaultId ? link.vaultB : link.vaultA
            )
            .filter(
              (vaultId) =>
                vaultId !== openSourceVaultId && !mounted.has(vaultId)
            )
            .map((vaultId) => ({
              vaultId,
              label: destinationLabel(vaultId, scopes),
            }))
        );
      })
      .catch(() => {
        if (live) setLinkDestinations([]);
      });
    return () => {
      live = false;
    };
  }, [visible]);

  const ownDestinations = (replica.scopes ?? [])
    .filter(
      (scope) =>
        scope.vaultId !== sourceVaultId && scope.canWrite && !scope.borrowed
    )
    .map((scope) => ({ vaultId: scope.vaultId, label: scope.label }));
  const destinations = [...ownDestinations, ...linkDestinations];

  const runGive = async (destination: {
    vaultId: string;
    label: string;
  }): Promise<void> => {
    setBusy(true);
    if (giveMany) {
      const outcome = await giveMany(destination);
      onDone({ verb: "give", ...outcome });
      onClose();
      return;
    }
    const session = replica.session;
    if (!session || !itemType || !itemIds?.length) {
      setBusy(false);
      return;
    }
    const outcomes = await Promise.all(
      itemIds.map((itemId) =>
        session
          .place({
            kind: "add",
            itemType,
            itemId,
            sourceVaultId,
            targetVaultId: destination.vaultId,
          })
          .then((result) => result.status === "executed")
          .catch(() => false)
      )
    );
    const failures = outcomes.filter((ok) => !ok).length;
    const count = itemIds.length;
    onDone({
      verb: "give",
      ok: failures === 0,
      message:
        failures === 0
          ? `Given to ${destination.label}.`
          : `${count - failures} of ${count} given to ${destination.label}; the rest did not land.`,
    });
    onClose();
  };

  const runLend = async (destination: {
    vaultId: string;
    label: string;
  }): Promise<void> => {
    if (!replica.session || !mintedIdFamilies?.length) return;
    setBusy(true);
    try {
      const record = await replica.session.lend({
        linkToken: Crypto.randomUUID(),
        // The lend's own item type is the ENTITY FAMILY being lent (the
        // whole library, per the file header), never the GIVE's `itemType`
        // prop — a call site can legitimately give one item type (an album,
        // say) and lend a different one (the library it lives in).
        itemType: mintedIdFamilies[0]!,
        scopes: wholeLibraryLendScope(mintedIdFamilies),
        sourceVaultId,
        targetVaultId: destination.vaultId,
      });
      onDone({
        verb: "lend",
        ok: record.status === "executed",
        message:
          record.status === "executed"
            ? `Lending to ${destination.label}.`
            : (record.reason ?? `Not lent to ${destination.label}.`),
      });
    } catch (error) {
      onDone({
        verb: "lend",
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : `Not lent to ${destination.label}.`,
      });
    }
    onClose();
  };

  const choose = (destination: { vaultId: string; label: string }): void => {
    if (verb === "give") {
      setConfirming(destination);
      return;
    }
    void runLend(destination);
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <TopSafeArea style={[styles.safe, { backgroundColor: colors.bg }]}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={[styles.title, { color: colors.text }]}>
              Share {noun.toLowerCase()}
            </Text>
          </View>
          <Pressable
            accessibilityLabel="Close"
            accessibilityRole="button"
            onPress={onClose}
          >
            <Text style={{ color: colors.accent }}>Cancel</Text>
          </Pressable>
        </View>

        {verbs.length > 1 ? (
          <View style={[styles.toggle, { borderColor: colors.line }]}>
            {verbs.map((candidate) => (
              <Pressable
                accessibilityLabel={candidate === "give" ? "Give" : "Lend"}
                accessibilityRole="button"
                accessibilityState={{ selected: verb === candidate }}
                key={candidate}
                onPress={() => setVerb(candidate)}
                style={[
                  styles.toggleTab,
                  verb === candidate && { backgroundColor: colors.bgElev },
                ]}
              >
                <Text
                  style={{
                    color: verb === candidate ? colors.accent : colors.textSoft,
                  }}
                >
                  {candidate === "give" ? "Give" : "Lend"}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {verb === "lend" ? (
          <Text style={[styles.note, { color: colors.textSoft }]}>
            Lending shares your whole {appLabel ?? "library"} as a live view —
            not just what’s selected here.
          </Text>
        ) : (
          <Text style={[styles.note, { color: colors.textSoft }]}>
            {verb === "give"
              ? "This makes a copy they own. You can’t take it back — only ask."
              : ""}
          </Text>
        )}

        {confirming ? (
          <View style={styles.confirm}>
            <Text style={[styles.note, { color: colors.text }]}>
              Giving makes a copy {confirming.label} owns. You can’t take it
              back — only ask.
            </Text>
            <View style={styles.confirmActions}>
              <Pressable
                accessibilityRole="button"
                onPress={() => setConfirming(null)}
                style={[styles.row, { borderColor: colors.line }]}
              >
                <Text style={[styles.rowTitle, { color: colors.textSoft }]}>
                  Back
                </Text>
              </Pressable>
              <Pressable
                accessibilityLabel={`Give — can't undo — to ${confirming.label}`}
                accessibilityRole="button"
                disabled={busy}
                onPress={() => void runGive(confirming)}
                style={[
                  styles.row,
                  {
                    backgroundColor: colors.accent,
                    borderColor: colors.accent,
                  },
                ]}
              >
                <Text style={[styles.rowTitle, { color: colors.bg }]}>
                  Give — can’t undo
                </Text>
              </Pressable>
            </View>
          </View>
        ) : destinations.length === 0 ? (
          <Text style={[styles.empty, { color: colors.textSoft }]}>
            There is nowhere to share to yet — no other vault, and nobody
            linked.
          </Text>
        ) : (
          destinations.map((destination) => (
            <Pressable
              accessibilityLabel={`${verb === "give" ? "Give" : "Lend"} to ${destination.label}`}
              accessibilityRole="button"
              disabled={busy}
              key={destination.vaultId}
              onPress={() => choose(destination)}
              style={[
                styles.row,
                { backgroundColor: colors.bgElev, borderColor: colors.line },
              ]}
            >
              <Text style={[styles.rowTitle, { color: colors.text }]}>
                {destination.label}
              </Text>
            </Pressable>
          ))
        )}
      </TopSafeArea>
    </Modal>
  );
}

const styles = StyleSheet.create({
  confirm: { gap: spacing[3], paddingHorizontal: spacing[4] },
  confirmActions: { flexDirection: "row", gap: spacing[2] },
  empty: { lineHeight: 22, paddingVertical: 18 },
  header: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing[3],
    justifyContent: "space-between",
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  headerCopy: { flex: 1 },
  note: {
    ...t("small"),
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
  row: {
    alignItems: "center",
    borderRadius: radii.md,
    borderWidth: borders.hairline,
    flexDirection: "row",
    justifyContent: "space-between",
    marginHorizontal: spacing[4],
    marginBottom: spacing[2],
    minHeight: 58,
    paddingHorizontal: 16,
  },
  rowTitle: t("body"),
  safe: { flex: 1 },
  title: t("title"),
  toggle: {
    borderRadius: radii.md,
    borderWidth: borders.hairline,
    flexDirection: "row",
    marginHorizontal: spacing[4],
    marginBottom: spacing[2],
    overflow: "hidden",
  },
  toggleTab: { alignItems: "center", flex: 1, paddingVertical: spacing[2] },
});
