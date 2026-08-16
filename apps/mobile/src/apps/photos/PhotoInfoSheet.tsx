// The info rail, as a phone sheet: 64% of the screen, with a grabber, opened by
// Info or by a swipe up (§7.2).
//
// Every row here is a *write* — something that can succeed, be queued, be
// refused, or be undone — not a read-out. That is why a refusal renders as a
// panel of its own rather than an alert: it has to say what was tried, why it
// was refused, and what to do, and it has to leave the typed text on the device
// so the member has not lost their sentence (§13).
//
// Below the hairline the Facts are mono, because a number is not a word: the
// numeric role pins its own direction so a dimension does not read back to
// front under RTL. Last comes one paragraph on where the original actually is —
// an original that is offloaded, on the gateway, or behind a metered connection
// is a truthful state with a sentence, never a broken image (§12).
//
// OWNER RULING (#711, 2a/2c) — do not "fix" this back:
//  - This sheet stays on PAPER, not stage ground, same as the web rail. Both
//    clients arrived at this independently, and Google Photos (our north
//    star) does the same: dense facts read better on paper, and the stage
//    exists to frame the photograph, not to host text. This is a deliberate
//    amendment to the prototype's `vInfoStyle`, which had seated the panel
//    over the stage.
//  - There is NO destructive control on this sheet, and there never has
//    been one here — Trash lives only on the viewer bar
//    (PhotoLightboxToolbar.tsx). A second destructive path inside a facts
//    panel is a misfire waiting to happen, and the prototype's own panel
//    deliberately carries no destructive control either.

import React, { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";

import Grabber from "../../kit/components/Grabber";
import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import { spacing, useTheme } from "../../kit/theme";
import { styles } from "./PhotoLightbox.styles";
import type { PhotoAsset } from "./timeline-model";
import {
  infoSheetHeight,
  originalStatus,
  originalWhereabouts,
  resolveOriginalPlacement,
  vaultLine,
} from "./viewer-model";

export interface InfoChip {
  id: string;
  label: string;
}

/** What the sheet needs that the asset record does not carry itself. */
export interface PhotoInfoSheetProps {
  visible: boolean;
  onClose: () => void;
  asset: PhotoAsset;
  screenHeight: number;
  placeName?: string;
  placeSetByYou: boolean;
  onRemovePlace: () => void;
  tags: readonly InfoChip[];
  onAddTag: (label: string) => Promise<string | undefined>;
  people: readonly InfoChip[];
  /** The vault the photograph is in, and what it *is* — never its name. */
  /** Whether the vault this photograph sits in is the member's OWN. Undefined
   *  when the scope is not known here — the row is then simply not drawn. */
  vaultPersonal?: boolean;
  vaultLabel: string;
  gatewayName: string;
  networkType?: string;
  fullQualityUnlocked: boolean;
  onCaption: (caption: string) => Promise<string | undefined>;
}

/** A write the vault would not take, kept on screen with the text intact. */
interface Refusal {
  tried: string;
  because: string;
}

export function PhotoInfoSheet(
  props: PhotoInfoSheetProps
): React.JSX.Element | null {
  const { asset, visible, onClose } = props;
  const { colors } = useTheme();
  const [caption, setCaption] = useState(asset.filename ?? "");
  const [captionAssetId, setCaptionAssetId] = useState(asset.id);
  const [pendingTag, setPendingTag] = useState("");
  const [refusal, setRefusal] = useState<Refusal>();
  // Page to another photograph and the sheet is about that one instead. Derived
  // during render so the field can never show the previous caption for a frame.
  if (captionAssetId !== asset.id) {
    setCaptionAssetId(asset.id);
    setCaption(asset.filename ?? "");
    setPendingTag("");
    setRefusal(undefined);
  }

  const placement = resolveOriginalPlacement({
    hasDeviceOriginal: Boolean(asset.localId ?? asset.localIds?.length),
    networkType: props.networkType,
    offloaded: asset.backupState === "remote-only",
    unlocked: props.fullQualityUnlocked,
  });
  const status = originalStatus(placement, props.gatewayName);
  const vault =
    props.vaultPersonal === undefined
      ? undefined
      : vaultLine(props.vaultPersonal, props.vaultLabel);
  // An asset the device's media store gave no timestamp for has no capture
  // date to print. It says so rather than formatting `new Date(undefined)`,
  // which renders "Invalid Date" — a fact the sheet does not have, dressed as
  // one it does.
  const capture = useMemo(
    () =>
      asset.capturedAt === undefined
        ? "no capture date recorded"
        : new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(new Date(asset.capturedAt)),
    [asset.capturedAt]
  );
  const timezone =
    asset.tzOffsetMin == null
      ? "no original offset — shown in this device's time"
      : `${formatTimezoneOffset(asset.tzOffsetMin)} — the offset the camera recorded`;

  const commit = (
    write: () => Promise<string | undefined>,
    tried: string
  ): void => {
    void write().then((because) => {
      // The typed text stays exactly where it is; only the reason is new.
      setRefusal(because === undefined ? undefined : { because, tried });
    });
  };

  if (!visible) return null;
  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      {/* No scrim: the prototype seats this panel *inside* the stage
          (`vInfoStyle`, mobile branch — an absolutely positioned 64%-height
          panel over the stage with a hairline top edge and no backdrop).
          The stage is already the darkest surface in the system, so dimming
          it a second time only muddies the photograph the panel describes.
          The pressable stays: it is the tap-outside-to-close target. */}
      <Pressable
        accessibilityLabel="Close photo information"
        accessibilityRole="button"
        onPress={onClose}
        style={styles.modalBackdrop}
      />
      <View
        style={[
          styles.sheet,
          {
            backgroundColor: colors.bgElev,
            height: infoSheetHeight(props.screenHeight),
          },
        ]}
      >
        <View style={styles.grabberSlot}>
          <Grabber />
        </View>
        <ScrollView contentContainerStyle={styles.sheetBody}>
          <Text style={[styles.sheetTitle, { color: colors.text }]}>
            {asset.filename ?? "This photograph"}
          </Text>

          <Row label="Caption" colors={colors}>
            <TextInput
              accessibilityLabel="Caption"
              onBlur={() =>
                commit(() => props.onCaption(caption), `Caption “${caption}”`)
              }
              onChangeText={setCaption}
              placeholder="Say what this is"
              placeholderTextColor={colors.textFaint}
              style={[
                styles.captionInput,
                { borderBottomColor: colors.lineStrong, color: colors.text },
              ]}
              value={caption}
            />
          </Row>

          <Row label="Capture time" colors={colors}>
            <Text style={[styles.infoValue, { color: colors.text }]}>
              {capture}
            </Text>
            <Text style={[styles.infoMeaning, { color: colors.textSoft }]}>
              {timezone}
            </Text>
          </Row>

          <Row label="Place" colors={colors}>
            <Text style={[styles.infoValue, { color: colors.text }]}>
              {props.placeName ?? "No place"}
            </Text>
            {props.placeName ? (
              <View style={styles.chipRow}>
                <Text style={[styles.infoMeaning, { color: colors.textSoft }]}>
                  {props.placeSetByYou ? "set by you" : "from the camera"}
                </Text>
                <Pressable
                  accessibilityLabel="Remove place"
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={props.onRemovePlace}
                >
                  <Text style={[styles.chipText, { color: colors.link }]}>
                    remove
                  </Text>
                </Pressable>
              </View>
            ) : null}
          </Row>

          <Row label="Tags" colors={colors}>
            <View style={styles.chipRow}>
              {props.tags.map((tag) => (
                <View
                  key={tag.id}
                  style={[styles.chip, { borderColor: colors.lineStrong }]}
                >
                  <Text style={[styles.chipText, { color: colors.text }]}>
                    {tag.label}
                  </Text>
                </View>
              ))}
              <View style={[styles.chip, { borderColor: colors.lineStrong }]}>
                <Icon name="plus" size={14} color={colors.textSoft} />
                <TextInput
                  accessibilityLabel="Add a tag"
                  onChangeText={setPendingTag}
                  onSubmitEditing={() => {
                    const label = pendingTag.trim();
                    if (!label) return;
                    commit(() => props.onAddTag(label), `Tag “${label}”`);
                    setPendingTag("");
                  }}
                  placeholder="add"
                  placeholderTextColor={colors.textFaint}
                  returnKeyType="done"
                  style={[styles.chipText, { color: colors.text }]}
                  value={pendingTag}
                />
              </View>
            </View>
          </Row>

          <Row label="People" colors={colors}>
            <View style={styles.chipRow}>
              {props.people.length === 0 ? (
                <Text style={[styles.infoValue, { color: colors.textSoft }]}>
                  Nobody named here yet
                </Text>
              ) : (
                props.people.map((person) => (
                  <View
                    key={person.id}
                    style={[styles.chip, { borderColor: colors.lineStrong }]}
                  >
                    <Text style={[styles.chipText, { color: colors.text }]}>
                      {person.label}
                    </Text>
                  </View>
                ))
              )}
            </View>
          </Row>

          {vault ? (
            <Row label="Vault" colors={colors}>
              <Text style={[styles.infoValue, { color: colors.text }]}>
                {vault.value}
              </Text>
              <Text style={[styles.infoMeaning, { color: colors.textSoft }]}>
                {vault.meaning}
              </Text>
            </Row>
          ) : null}

          {refusal ? (
            <View style={[styles.refusal, { borderColor: colors.net }]}>
              <Text style={[styles.refusalTitle, { color: colors.net }]}>
                {refusal.tried} was not written
              </Text>
              <Text style={[styles.refusalText, { color: colors.net }]}>
                {refusal.because}
              </Text>
              <Text style={[styles.refusalText, { color: colors.textSoft }]}>
                Read-only vault — ask its owner for write access, then try
                again.
              </Text>
            </View>
          ) : null}

          <View style={[styles.hairline, { borderTopColor: colors.line }]}>
            <Text style={[styles.infoLabel, { color: colors.textSoft }]}>
              Facts
            </Text>
            {factRows(asset).map(([label, value]) => (
              <View key={label} style={styles.factsRow}>
                <Text style={[styles.factLabel, { color: colors.textSoft }]}>
                  {label}
                </Text>
                <Text
                  selectable
                  numberOfLines={2}
                  style={[styles.facts, { color: colors.text }]}
                >
                  {value}
                </Text>
              </View>
            ))}
          </View>

          <View
            style={[
              styles.hairline,
              { borderTopColor: colors.line, gap: spacing[1] },
            ]}
          >
            <Text style={[styles.infoValue, { color: colors.text }]}>
              {status.text}
            </Text>
            <Text style={[styles.infoMeaning, { color: colors.textSoft }]}>
              {originalWhereabouts(status)}
            </Text>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

function Row({
  label,
  colors,
  children,
}: {
  label: string;
  colors: ReturnType<typeof useTheme>["colors"];
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={styles.infoRow}>
      <Text style={[styles.infoLabel, { color: colors.textSoft }]}>
        {label}
      </Text>
      {children}
    </View>
  );
}

function factRows(asset: PhotoAsset): [string, string][] {
  return [
    [
      "Dimensions",
      asset.width && asset.height
        ? `${asset.width} × ${asset.height}`
        : "not recorded",
    ],
    [
      "File size",
      asset.fileSize == null
        ? "not recorded"
        : `${(asset.fileSize / 1024 / 1024).toFixed(asset.fileSize > 10_485_760 ? 0 : 1)} MB`,
    ],
    ["Kind", asset.kind],
    [
      "Timezone",
      asset.tzOffsetMin == null
        ? "not recorded"
        : formatTimezoneOffset(asset.tzOffsetMin),
    ],
    ["Source", asset.scopeLabels?.join(" · ") || asset.source],
    ["Asset id", asset.assetId ?? asset.id],
  ];
}

function formatTimezoneOffset(offsetMinutes: number): string {
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return `UTC${offsetMinutes >= 0 ? "+" : "-"}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
