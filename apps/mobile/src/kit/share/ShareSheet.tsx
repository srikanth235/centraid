// THE SHARE SHEET — the one surface in the product that reaches another person.
//
// Shaped after the share dialog everybody already knows (Drive's): a search
// field, one row per person carrying their face and a ROLE control on the
// right, a general-access block stating what a share costs, and a single
// primary action. The role menu is the whole interaction — the older sheet
// asked twice (a checkbox, then a segmented control that appeared underneath
// and reflowed the row), which put the two halves of one decision in two
// places.
//
// WHO IS LISTED IS NOT A UI CHOICE. A share is delivered into the receiver's
// own vault, so the audience is exactly who this vault is LINKED to
// (`share-targets.ts`). There is no invite-a-stranger row, because there is no
// mechanism behind one.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { View as RNView } from "react-native";

import { manualShareSelection } from "@centraid/blueprints/apps/_shared/named-circle-selection";
import type { PlaceableItemType } from "@centraid/blueprints/apps/_shared/placement-registry";
import {
  SHARE_FAILED,
  sharedWithOutcome,
} from "@centraid/blueprints/apps/_shared/shared-copy";

import { listLinks } from "../../lib/replica/links-transport";
import type { GatewayLink } from "../../lib/replica/links-transport";
import AnchoredMenu from "../components/AnchoredMenu";
import type { MenuAnchor } from "../components/AnchoredMenu";
import Icon from "../components/Icon";
import { Text, TextInput } from "../components/NativeText";
import PersonAvatar from "../components/PersonAvatar";
import Tappable from "../components/Tappable";
import TopSafeArea from "../components/TopSafeArea";
import { useReplicaQuery } from "../hooks/useReplicaQuery";
import { useReplica } from "../replica/ReplicaProvider";
import { TEST_IDS } from "../test-ids";
import { borders, radii, spacing, t, useTheme } from "../theme";
import type { ThemeColors } from "../theme";
import { useNamedShareCircles } from "./named-circles";
import {
  nativeShareTargets,
  selectionsForNativeCircle,
  selectedNativeShareMembers,
} from "./share-targets";
import type { NativeShareTarget } from "./share-targets";

export type ShareVerb = "share";

type ShareCapability = "read" | "read+write";
type ShareSelections = Record<string, ShareCapability>;

const ROLE_LABEL: Record<ShareCapability, string> = {
  read: "Viewer",
  "read+write": "Editor",
};
const NO_ACCESS = "No access";

const GENERAL_ACCESS =
  "Everyone you add gets the full shared item in their own vault and backup.";

const NOBODY_LINKED =
  "You have not linked with anyone yet. Settings → People & circles is where a link is made.";

export interface ShareSheetProps {
  visible: boolean;
  onClose: () => void;
  sourceVaultId: string;
  noun: string;
  itemType?: PlaceableItemType;
  itemIds?: readonly string[];
  appLabel?: string;
  onDone: (outcome: { verb: ShareVerb; ok: boolean; message: string }) => void;
  preferredCircleId?: string;
}

export default function ShareSheet({
  visible,
  onClose,
  sourceVaultId,
  noun,
  itemType,
  itemIds,
  onDone,
  preferredCircleId,
}: ShareSheetProps): React.JSX.Element {
  const { colors } = useTheme();
  const replica = useReplica();
  const parties = useReplicaQuery(
    "people",
    useMemo(() => ({ entity: "core.party", limit: 500 }), [])
  );
  const vault = useReplicaQuery(
    "people",
    useMemo(() => ({ entity: "core.vault", limit: 1 }), [])
  );
  const [links, setLinks] = useState<GatewayLink[]>([]);
  const [selections, setSelections] = useState<ShareSelections>({});
  const [busy, setBusy] = useState(false);
  const [selectedCircleId, setSelectedCircleId] = useState("");
  const [query, setQuery] = useState("");
  const preselectedRef = useRef(false);
  const openInputsRef = useRef({
    gatewayBase: replica.gatewayBase,
  });

  useEffect(() => {
    openInputsRef.current = {
      gatewayBase: replica.gatewayBase,
    };
  });

  useEffect(() => {
    if (!visible) return;
    preselectedRef.current = false;
    const { gatewayBase } = openInputsRef.current;
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      setBusy(false);
      setSelections({});
      setSelectedCircleId("");
      setQuery("");
      if (!gatewayBase) return;
      try {
        const nextLinks = await listLinks(gatewayBase);
        if (active) setLinks(nextLinks);
      } catch {
        if (active) setLinks([]);
      }
    });
    return () => {
      active = false;
    };
  }, [visible]);

  const ownerPartyId =
    typeof vault.rows[0]?.self_party_id === "string"
      ? vault.rows[0].self_party_id
      : undefined;
  const destinations = nativeShareTargets({
    sourceVaultId,
    ownerPartyId,
    parties: parties.rows,
    links,
    scopes: replica.scopes ?? [],
  });
  const selected = destinations.flatMap((destination) =>
    selections[destination.id] ? [destination] : []
  );
  const members = selectedNativeShareMembers(destinations, selections);
  const namedCircles = useNamedShareCircles(destinations, ownerPartyId);

  const needle = query.trim().toLowerCase();
  const shown = needle
    ? destinations.filter((destination) =>
        destination.label.toLowerCase().includes(needle)
      )
    : destinations;

  useEffect(() => {
    if (!visible || preselectedRef.current || !preferredCircleId) return;
    const circle = namedCircles.find(
      (candidate) => candidate.circleId === preferredCircleId
    );
    if (!circle) return;
    preselectedRef.current = true;
    const preselected = selectionsForNativeCircle(destinations, circle);
    void Promise.resolve().then(() => {
      setSelectedCircleId(circle.circleId);
      setSelections(preselected);
    });
  }, [destinations, namedCircles, preferredCircleId, visible]);

  const setRole = (
    destinationId: string,
    role: ShareCapability | undefined
  ): void => {
    const next = manualShareSelection(selections, destinationId, role);
    setSelectedCircleId(next.circleId);
    setSelections(next.selections);
  };

  const share = async (): Promise<void> => {
    if (!replica.session || !itemType || !itemIds?.length || !selected.length)
      return;
    setBusy(true);
    try {
      await Promise.all(
        itemIds.map((containerId) =>
          replica.session!.share({
            sourceVaultId,
            containerType: itemType,
            containerId,
            members,
            ...(selectedCircleId ? { circleId: selectedCircleId } : {}),
          })
        )
      );
      onDone({
        verb: "share",
        ok: true,
        message: sharedWithOutcome(selected.length),
      });
    } catch (error) {
      onDone({
        verb: "share",
        ok: false,
        message: error instanceof Error ? error.message : SHARE_FAILED,
      });
    } finally {
      setBusy(false);
      onClose();
    }
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <TopSafeArea
        style={[styles.safe, { backgroundColor: colors.bg }]}
        testID={TEST_IDS.shell.shareSheet}
      >
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.text }]}>
            Share {noun.toLowerCase()}
          </Text>
          <Tappable
            accessibilityLabel="Cancel"
            onPress={onClose}
            testID={TEST_IDS.shell.shareSheetCancel}
          >
            <Text style={{ color: colors.accent }}>Cancel</Text>
          </Tappable>
        </View>

        {destinations.length === 0 ? (
          <Text style={[styles.empty, { color: colors.textSoft }]}>
            {NOBODY_LINKED}
          </Text>
        ) : (
          <>
            <View
              style={[
                styles.search,
                { backgroundColor: colors.bgElev, borderColor: colors.line },
              ]}
            >
              <Icon name="search" size={16} color={colors.textSoft} />
              <TextInput
                accessibilityLabel="Search the people you are linked with"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
                onChangeText={setQuery}
                placeholder="Search people"
                placeholderTextColor={colors.textFaint}
                style={[styles.searchField, { color: colors.text }]}
                value={query}
              />
            </View>

            {namedCircles.length ? (
              <ScrollView
                contentContainerStyle={styles.circleRow}
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.circleList}
              >
                {namedCircles.map((circle) => {
                  const on = selectedCircleId === circle.circleId;
                  return (
                    <Pressable
                      key={circle.circleId}
                      accessibilityLabel={`Select the group ${circle.label}`}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                      onPress={() => {
                        const next = on ? "" : circle.circleId;
                        setSelectedCircleId(next);
                        setSelections(
                          next
                            ? selectionsForNativeCircle(destinations, circle)
                            : {}
                        );
                      }}
                      style={[
                        styles.circlePill,
                        {
                          borderColor: on ? colors.accent : colors.line,
                          backgroundColor: on ? colors.bgElev : colors.bg,
                        },
                      ]}
                    >
                      <Icon name="users" size={14} color={colors.accent} />
                      <Text style={[t("small"), { color: colors.accent }]}>
                        {circle.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : null}

            <ScrollView contentContainerStyle={styles.list}>
              <Text style={[styles.sectionTitle, { color: colors.textSoft }]}>
                PEOPLE YOU CAN REACH
              </Text>
              {shown.length === 0 ? (
                <Text style={[styles.noMatch, { color: colors.textSoft }]}>
                  Nobody linked matches “{query.trim()}”.
                </Text>
              ) : (
                shown.map((destination) => (
                  <PersonShareRow
                    key={destination.id}
                    busy={busy}
                    colors={colors}
                    destination={destination}
                    onRole={(role) => setRole(destination.id, role)}
                    role={selections[destination.id]}
                  />
                ))
              )}

              <Text style={[styles.sectionTitle, { color: colors.textSoft }]}>
                GENERAL ACCESS
              </Text>
              <View style={styles.generalAccess}>
                <Icon name="shield" size={16} color={colors.textSoft} />
                <Text style={[styles.generalCopy, { color: colors.textSoft }]}>
                  {GENERAL_ACCESS}
                </Text>
              </View>
            </ScrollView>
          </>
        )}

        <View style={styles.footer}>
          <Pressable
            accessibilityLabel={
              selected.length
                ? `Share with ${selected.length} ${selected.length === 1 ? "person" : "people"}`
                : "Share"
            }
            accessibilityRole="button"
            accessibilityState={{ disabled: busy || selected.length === 0 }}
            disabled={busy || selected.length === 0}
            onPress={() => void share()}
            style={[
              styles.shareButton,
              {
                backgroundColor:
                  busy || selected.length === 0
                    ? colors.bgSunken
                    : colors.accent,
              },
            ]}
          >
            <Text
              style={{
                color:
                  busy || selected.length === 0
                    ? colors.textSoft
                    : colors.textInv,
              }}
            >
              {busy
                ? "Sharing…"
                : selected.length
                  ? `Share with ${selected.length}`
                  : "Share"}
            </Text>
          </Pressable>
        </View>
      </TopSafeArea>
    </Modal>
  );
}

/**
 * One person, one line: their face, their name, the vault a share would land
 * in, and the role control. The role is a MENU rather than a pair of toggles
 * because "not shared with" is one of its answers — a control that can only
 * choose between two capabilities has to be paired with a separate on/off, and
 * that pairing is what made the old row take two lines and reflow when tapped.
 */
function PersonShareRow({
  busy,
  colors,
  destination,
  onRole,
  role,
}: {
  busy: boolean;
  colors: ThemeColors;
  destination: NativeShareTarget;
  onRole: (role: ShareCapability | undefined) => void;
  role: ShareCapability | undefined;
}): React.JSX.Element {
  const anchorRef = useRef<RNView>(null);
  const [anchor, setAnchor] = useState<MenuAnchor>();
  const [open, setOpen] = useState(false);
  const label = role ? ROLE_LABEL[role] : NO_ACCESS;

  const choose = (next: ShareCapability | undefined): void => {
    setOpen(false);
    onRole(next);
  };

  return (
    <View style={styles.row}>
      {/* Every person here is linked BY CONSTRUCTION, so the ring is solid
          ink: there is no unlinked row for a dashed one to describe. */}
      <PersonAvatar
        link="linked"
        person={{ party_id: destination.partyId, name: destination.label }}
      />
      <View style={styles.rowCopy}>
        <Text style={[t("body"), { color: colors.text }]}>
          {destination.label}
        </Text>
        <Text style={[t("small"), { color: colors.textSoft }]}>
          Linked vault
        </Text>
      </View>
      <View collapsable={false} ref={anchorRef}>
        <Pressable
          accessibilityLabel={`${destination.label}: ${label}. Change their access`}
          accessibilityRole="button"
          disabled={busy}
          onPress={() => {
            anchorRef.current?.measureInWindow((x, y, width, height) =>
              setAnchor({ x, y, width, height })
            );
            setOpen(true);
          }}
          style={[styles.role, { borderColor: colors.line }]}
        >
          <Text
            style={[
              t("small"),
              { color: role ? colors.accent : colors.textSoft },
            ]}
          >
            {label}
          </Text>
          <Icon
            name="chevron-down"
            size={14}
            color={role ? colors.accent : colors.textSoft}
          />
        </Pressable>
      </View>
      <AnchoredMenu
        anchor={anchor}
        groups={[
          {
            key: "role",
            rows: [
              {
                key: "read",
                label: ROLE_LABEL.read,
                checked: role === "read",
                onSelect: () => choose("read"),
              },
              {
                key: "read+write",
                label: ROLE_LABEL["read+write"],
                checked: role === "read+write",
                onSelect: () => choose("read+write"),
              },
              {
                key: "none",
                label: NO_ACCESS,
                checked: role === undefined,
                onSelect: () => choose(undefined),
              },
            ],
          },
        ]}
        onClose={() => setOpen(false)}
        visible={open}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  circleList: { flexGrow: 0, paddingBottom: spacing[2] },
  circlePill: {
    alignItems: "center",
    borderRadius: radii.pill,
    borderWidth: borders.hairline,
    flexDirection: "row",
    gap: spacing[1],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  circleRow: {
    flexDirection: "row",
    gap: spacing[2],
    paddingHorizontal: spacing[4],
  },
  empty: {
    ...t("body"),
    flex: 1,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[4],
  },
  footer: { paddingHorizontal: spacing[4], paddingVertical: spacing[3] },
  generalAccess: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  generalCopy: { ...t("small"), flex: 1 },
  header: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing[3],
    justifyContent: "space-between",
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  list: { paddingBottom: spacing[2] },
  noMatch: {
    ...t("small"),
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  role: {
    alignItems: "center",
    borderRadius: radii.pill,
    borderWidth: borders.hairline,
    flexDirection: "row",
    gap: spacing[1],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
    minHeight: 60,
    paddingHorizontal: spacing[4],
  },
  rowCopy: { flex: 1 },
  safe: { flex: 1 },
  search: {
    alignItems: "center",
    borderRadius: radii.pill,
    borderWidth: borders.hairline,
    flexDirection: "row",
    gap: spacing[2],
    marginHorizontal: spacing[4],
    marginBottom: spacing[3],
    minHeight: 44,
    paddingHorizontal: spacing[3],
  },
  searchField: { ...t("body"), flex: 1, minHeight: 44 },
  sectionTitle: {
    ...t("control"),
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    paddingBottom: spacing[1],
  },
  shareButton: {
    alignItems: "center",
    borderRadius: radii.md,
    justifyContent: "center",
    minHeight: 46,
  },
  title: t("title"),
});
