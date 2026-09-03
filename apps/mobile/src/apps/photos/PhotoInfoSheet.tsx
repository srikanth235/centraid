import * as Clipboard from "expo-clipboard";
import React, { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";

import type { NamedPlace } from "@centraid/blueprints/apps/photos/place-phrase";
import {
  exactLocation,
  placePhrase,
} from "@centraid/blueprints/apps/photos/place-phrase";

import Grabber from "../../kit/components/Grabber";
import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import Tappable from "../../kit/components/Tappable";
import { TEST_IDS } from "../../kit/test-ids";
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

export interface PhotoInfoSheetProps {
  visible: boolean;
  onClose: () => void;
  asset: PhotoAsset;
  screenHeight: number;
  placeName?: string;
  placeGazetteer?: string;
  placeLat?: number;
  placeLng?: number;
  namedPlaces?: readonly NamedPlace[];
  placeSetByYou: boolean;
  onRemovePlace: () => void;
  tags: readonly InfoChip[];
  onAddTag: (label: string) => Promise<string | undefined>;
  people: readonly InfoChip[];
  vaultPersonal?: boolean;
  vaultLabel: string;
  gatewayName: string;
  networkType?: string;
  fullQualityUnlocked: boolean;
  onCaption: (caption: string) => Promise<string | undefined>;
}

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
  const [copiedLocation, setCopiedLocation] = useState(false);
  if (captionAssetId !== asset.id) {
    setCaptionAssetId(asset.id);
    setCaption(asset.filename ?? "");
    setPendingTag("");
    setRefusal(undefined);
    setCopiedLocation(false);
  }

  const place = placePhrase({
    placeName: props.placeName,
    gazetteerName: props.placeGazetteer,
    lat: props.placeLat,
    lng: props.placeLng,
    namedPlaces: props.namedPlaces,
    context: "private",
  });
  const exact = exactLocation(props.placeLat, props.placeLng);

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
      setRefusal(because === undefined ? undefined : { because, tried });
    });
  };

  if (!visible) return null;
  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      {/* No scrim: this panel sits *inside* the stage (`vInfoStyle`), which is
          already the darkest surface — dimming it again muddies the photograph.
          The pressable stays as the tap-outside-to-close target. */}
      <Pressable
        accessibilityLabel="Close photo information"
        accessibilityRole="button"
        onPress={onClose}
        style={styles.modalBackdrop}
        testID={TEST_IDS.photos.infoClose}
      />
      <View
        style={[
          styles.sheet,
          {
            backgroundColor: colors.bgElev,
            height: infoSheetHeight(props.screenHeight),
          },
        ]}
        testID={TEST_IDS.photos.infoSheet}
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
              {place.source === "none" && props.placeName === undefined
                ? "No place"
                : place.text}
            </Text>
            {props.placeName ? (
              <View style={styles.chipRow}>
                <Text style={[styles.infoMeaning, { color: colors.textSoft }]}>
                  {props.placeSetByYou ? "set by you" : "from the camera"}
                </Text>
                <Tappable
                  accessibilityLabel="Remove place"
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={props.onRemovePlace}
                >
                  <Text style={[styles.chipText, { color: colors.link }]}>
                    remove
                  </Text>
                </Tappable>
              </View>
            ) : null}
            {/* Spells the coordinate out only because the member asked; the
                label carries no digits — printing it would be handing it over. */}
            {exact === null ? null : (
              <View style={styles.chipRow}>
                <Tappable
                  accessibilityLabel="Copy exact location"
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={() => {
                    void Clipboard.setStringAsync(exact).then(() =>
                      setCopiedLocation(true)
                    );
                  }}
                >
                  <Text style={[styles.chipText, { color: colors.link }]}>
                    Copy exact location
                  </Text>
                </Tappable>
                {copiedLocation ? (
                  <Text
                    style={[styles.infoMeaning, { color: colors.textSoft }]}
                  >
                    Copied
                  </Text>
                ) : null}
              </View>
            )}
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
