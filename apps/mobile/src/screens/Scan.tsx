import { CameraView, useCameraPermissions } from "expo-camera";
import { File } from "expo-file-system";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  OCR_CONSENT_NOTE,
  OCR_DECLINED_INLINE,
  OCR_GATEWAY_NOT_A_CHOICE,
  OCR_GATEWAY_PANEL,
  OCR_ON_DEVICE_PANEL,
} from "@centraid/blueprints/apps/_shared/capture-consent";
import {
  allocateMinorUnits,
  parseReceiptText,
} from "@centraid/client/receipt-capture";
import type {
  ReceiptDraft,
  ReceiptLineDraft,
} from "@centraid/client/receipt-capture";

import { recognizeText } from "../../modules/centraid-ocr";
import { ConsentGate } from "../kit/components/ConsentGate";
import { Text } from "../kit/components/NativeText";
import { postStatus } from "../kit/components/status-line";
import { useReplicaQuery } from "../kit/hooks/useReplicaQuery";
import { useReplica } from "../kit/replica/ReplicaProvider";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../kit/replica/write-outcome";
import { useTheme } from "../kit/theme";
import { authHeader } from "../lib/gateway";
import {
  backupDeviceMedia,
  backupDocument,
  backupReceiptExpense,
} from "../lib/upload/media-producer";
import type { ScanScreenProps } from "../navigation";
import {
  answerScanOcrConsent,
  hydrateScanOcrConsent,
  scanOcrExtractionAllowed,
} from "./scan-consent";
import type { ScanOcrConsentRecord } from "./scan-consent";
import {
  ChoiceRows,
  CloseHeader,
  Field,
  parseCard,
  PrimaryButton,
  scanStyles as styles,
} from "./scan-ui";

type Destination = "tally" | "docs" | "photos" | "locker";
interface Extraction {
  text: string;
  confidence: number;
  engine: string;
}

const DESTINATIONS: Array<{ id: Destination; label: string }> = [
  { id: "tally", label: "Tally receipt" },
  { id: "docs", label: "Docs scan" },
  { id: "photos", label: "Photos" },
  { id: "locker", label: "Locker card" },
];

export default function ScanScreen({
  navigation,
  route,
}: ScanScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const camera = useRef<CameraView>(null);
  const extractedSource = useRef("");
  const [permission, requestPermission] = useCameraPermissions();
  const { gatewayBase, session, vaultId } = useReplica();
  const [fileUri, setFileUri] = useState(route.params?.fileUri ?? "");
  const [mediaType, setMediaType] = useState(
    route.params?.mediaType ?? "image/jpeg"
  );
  const [fileName, setFileName] = useState(
    () => route.params?.fileName ?? `scan-${Date.now()}.jpg`
  );
  const [destination, setDestination] = useState<Destination>("tally");
  const [extraction, setExtraction] = useState<Extraction>();
  const [receipt, setReceipt] = useState<ReceiptDraft>();
  const [groupId, setGroupId] = useState("");
  const [allocations, setAllocations] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>();
  // THE OCR CONSENT LATCH (issue #712 C3). `undefined` means either "not yet
  // hydrated" or "never answered" — `ocrConsentReady` tells the two apart so
  // the extraction effect below never fires on a half-read latch.
  const [ocrConsent, setOcrConsent] = useState<ScanOcrConsentRecord>();
  const [ocrConsentReady, setOcrConsentReady] = useState(false);

  useEffect(() => {
    let active = true;
    void hydrateScanOcrConsent().then((record) => {
      if (!active) return;
      setOcrConsent(record);
      setOcrConsentReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  const groups = useReplicaQuery(
    "tally",
    useMemo(() => ({ entity: "tally.group" }), [])
  );
  const circles = useReplicaQuery(
    "tally",
    useMemo(() => ({ entity: "social.circle" }), [])
  );
  const members = useReplicaQuery(
    "tally",
    useMemo(() => ({ entity: "social.circle_member" }), [])
  );
  const parties = useReplicaQuery(
    "tally",
    useMemo(() => ({ entity: "core.party" }), [])
  );
  const vault = useReplicaQuery(
    "tally",
    useMemo(() => ({ entity: "core.vault" }), [])
  );
  const activeGroupId = groupId || String(groups.rows[0]?.group_id ?? "");
  const activeCircleId = String(
    groups.rows.find((row) => String(row.group_id) === activeGroupId)
      ?.circle_id ?? ""
  );
  const participantIds = useMemo(
    () =>
      members.rows
        .filter((row) => String(row.circle_id) === activeCircleId)
        .map((row) => String(row.party_id)),
    [activeCircleId, members.rows]
  );

  const extract = useCallback(
    async (uri: string, kind: string) => {
      setBusy(true);
      setErrorMessage(undefined);
      try {
        let next: Extraction;
        try {
          next = await recognizeText(uri);
        } catch (nativeError) {
          if (!gatewayBase) throw nativeError;
          const file = new File(uri);
          const response = await fetch(
            `${gatewayBase}/centraid/_gateway/capture/ocr`,
            {
              method: "POST",
              headers: {
                ...authHeader(),
                "content-type": kind,
              },
              body: await file.bytes(),
            }
          );
          if (!response.ok)
            throw new Error(
              response.status === 503
                ? "On-device OCR is unavailable and this gateway has no local OCR backstop."
                : `OCR failed (HTTP ${response.status}).`,
              { cause: nativeError }
            );
          const body = (await response.json()) as {
            extraction: Extraction;
          };
          next = body.extraction;
        }
        setExtraction(next);
        const draft = parseReceiptText(next.text);
        setReceipt(draft);
        setAllocations({});
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [gatewayBase]
  );

  // THE LOAD-BEARING RULE (issue #712 C3): extraction is reachable only once
  // the latch has an explicit answer. While unanswered this waits — never
  // treats "not yet answered" as "declined" — so the gate below gets to ask
  // first. Once answered, this fires (or doesn't) exactly once per capture.
  useEffect(() => {
    if (!fileUri || !ocrConsentReady || !ocrConsent) return;
    const sourceKey = `${fileUri}\0${mediaType}`;
    if (extractedSource.current === sourceKey) return;
    extractedSource.current = sourceKey;
    if (!scanOcrExtractionAllowed(ocrConsent)) return;
    // Deferred a tick: `extract` sets state (busy) at its own top, before its
    // first await, and an effect body should not itself trigger a synchronous
    // React update — see https://react.dev/learn/you-might-not-need-an-effect.
    void Promise.resolve().then(() => extract(fileUri, mediaType));
  }, [extract, fileUri, mediaType, ocrConsent, ocrConsentReady]);

  const answerOcrConsent = useCallback(
    (answer: "on-device" | "not-now"): void => {
      setOcrConsent(answerScanOcrConsent(answer));
    },
    []
  );

  const takePhoto = async (): Promise<void> => {
    if (!permission?.granted) {
      const granted = await requestPermission();
      if (!granted.granted) {
        setErrorMessage("Camera access is required to scan a new image.");
      }
      return;
    }
    setBusy(true);
    try {
      const photo = await camera.current?.takePictureAsync({
        quality: 0.92,
        skipProcessing: false,
      });
      if (!photo?.uri) throw new Error("The camera did not return an image.");
      setFileName(`scan-${Date.now()}.jpg`);
      setMediaType("image/jpeg");
      setFileUri(photo.uri);
      setExtraction(undefined);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  const updateLine = (id: string, patch: Partial<ReceiptLineDraft>): void => {
    if (!receipt) return;
    const lines = receipt.lines.map((line) =>
      line.id === id ? { ...line, ...patch } : line
    );
    setReceipt({
      ...receipt,
      lines,
      amountMinor: lines.reduce((sum, line) => sum + line.amountMinor, 0),
      needsReview: false,
    });
  };

  const toggleParticipant = (lineId: string, partyId: string): void => {
    setAllocations((current) => {
      const selected = current[lineId] ?? participantIds;
      const next = selected.includes(partyId)
        ? selected.filter((id) => id !== partyId)
        : [...selected, partyId];
      return { ...current, [lineId]: next };
    });
  };

  const save = async (): Promise<void> => {
    if (!fileUri || !extraction || !session || !gatewayBase) return;
    setBusy(true);
    setErrorMessage(undefined);
    try {
      const local = new File(fileUri);
      const size = route.params?.plaintextSize ?? local.size;
      if (destination === "docs") {
        await backupDocument(session, gatewayBase, {
          localUri: fileUri,
          targetVaultId: vaultId,
          title: fileName,
          mediaType,
          plaintextSize: size,
          extractedText: extraction.text,
          deleteSourceAfterSettle:
            route.params?.deleteSourceAfterSettle ?? false,
        });
      } else if (destination === "photos") {
        await backupDeviceMedia(session, gatewayBase, {
          localUri: fileUri,
          targetVaultId: vaultId,
          filename: fileName,
          mediaType,
          plaintextSize: size,
          kind: "scan",
          capturedAt: new Date().toISOString(),
          deleteSourceAfterSettle:
            route.params?.deleteSourceAfterSettle ?? false,
        });
      } else if (destination === "locker") {
        const card = parseCard(extraction.text);
        const outcome = await session.write("locker", {
          action: "add-item",
          input: {
            type: "card",
            title: receipt?.merchant || "Scanned card",
            tags: ["scan"],
            cardholder: card.cardholder,
            card_number: card.cardNumber,
            expiry: card.expiry,
            notes:
              "Captured with on-device OCR. The source image was not stored in Locker.",
          },
        });
        if (
          !surfaceWriteOutcome(outcome, {
            onParked: () =>
              navigation.navigate("Settings", { screen: "Approvals" }),
          })
        )
          return;
      } else {
        if (!receipt) throw new Error("No receipt lines were extracted.");
        const ownerId = String(vault.rows[0]?.owner_party_id ?? "");
        if (!activeGroupId || !ownerId)
          throw new Error("Create or choose a Tally group first.");
        const lineItems = receipt.lines.map((line) => {
          const selected = allocations[line.id] ?? participantIds;
          if (selected.length === 0)
            throw new Error(`Choose who shares "${line.description}".`);
          return {
            kind: line.kind,
            description: line.description,
            amount_minor: line.amountMinor,
            allocations: allocateMinorUnits(line.amountMinor, selected),
          };
        });
        const splitMap = new Map<string, number>();
        for (const line of lineItems)
          for (const allocation of line.allocations)
            splitMap.set(
              allocation.party_id,
              (splitMap.get(allocation.party_id) ?? 0) + allocation.share_minor
            );
        await backupReceiptExpense(session, gatewayBase, {
          localUri: fileUri,
          targetVaultId: vaultId,
          filename: fileName,
          mediaType,
          plaintextSize: size,
          deleteSourceAfterSettle:
            route.params?.deleteSourceAfterSettle ?? false,
          group_id: activeGroupId,
          description: receipt.merchant,
          amount_minor: receipt.amountMinor,
          paid_by: ownerId,
          spent_on: new Date().toISOString().slice(0, 10),
          category: "food",
          ocr_text: extraction.text,
          splits: [...splitMap].map(([party_id, share_minor]) => ({
            party_id,
            share_minor,
          })),
          line_items: lineItems,
        });
      }
      postStatus(
        destination === "tally"
          ? "Receipt published to Tally."
          : `Scan saved to ${destination}.`,
        { action: { label: "Done", run: () => navigation.goBack() } }
      );
    } catch (error) {
      surfaceWriteFailure(error, "Scan not saved");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
      <CloseHeader colors={colors} onClose={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.content}>
        {fileUri && ocrConsentReady && !ocrConsent ? (
          // THE CONSENT GATE (issue #712 C3), shown once per device, before
          // the first extraction. Declining still saves the scan — the
          // destination flow below handles an unextracted scan inline,
          // never as a dead end.
          <ConsentGate
            domain="docs"
            onDevicePanel={OCR_ON_DEVICE_PANEL}
            onDevice={{ available: true }}
            netPanel={OCR_GATEWAY_PANEL}
            net={{ available: false, reason: OCR_GATEWAY_NOT_A_CHOICE }}
            note={OCR_CONSENT_NOTE}
            onRunOnDevice={() => answerOcrConsent("on-device")}
            onDecline={() => answerOcrConsent("not-now")}
          />
        ) : null}
        {fileUri && !(ocrConsentReady && !ocrConsent) ? (
          <>
            <Text style={[styles.help, { color: colors.textSoft }]}>
              {busy
                ? "Extracting text locally…"
                : extraction
                  ? `${extraction.engine} · ${Math.round(extraction.confidence * 100)}% extraction confidence`
                  : ocrConsent?.answer === "not-now"
                    ? OCR_DECLINED_INLINE
                    : "Extraction unavailable"}
            </Text>
            {errorMessage ? (
              <Text accessibilityRole="alert" style={{ color: colors.danger }}>
                {errorMessage}
              </Text>
            ) : null}
            {extraction || ocrConsent?.answer === "not-now" ? (
              <>
                <View style={styles.destinationGrid}>
                  {DESTINATIONS.map(({ id, label }) => (
                    <Pressable
                      key={id}
                      accessibilityRole="button"
                      accessibilityState={{ selected: destination === id }}
                      onPress={() => setDestination(id)}
                      style={[
                        styles.destination,
                        {
                          backgroundColor:
                            destination === id
                              ? colors.bgSunken
                              : colors.bgElev,
                          borderColor:
                            destination === id ? colors.accent : colors.line,
                        },
                      ]}
                    >
                      <Text style={{ color: colors.text }}>{label}</Text>
                    </Pressable>
                  ))}
                </View>
                {destination === "tally" && receipt ? (
                  <>
                    <Field
                      label="Merchant"
                      value={receipt.merchant}
                      onChangeText={(merchant) =>
                        setReceipt({ ...receipt, merchant })
                      }
                      colors={colors}
                    />
                    <ChoiceRows
                      label="Group"
                      rows={groups.rows.map((row) => {
                        const circle = circles.rows.find(
                          (candidate) =>
                            String(candidate.circle_id) ===
                            String(row.circle_id)
                        );
                        return {
                          id: String(row.group_id),
                          label: String(circle?.name ?? "Expense group"),
                        };
                      })}
                      selected={activeGroupId}
                      onSelect={(id) => {
                        setGroupId(id);
                        setAllocations({});
                      }}
                      colors={colors}
                    />
                    {receipt.lines.map((line) => (
                      <View
                        key={line.id}
                        style={[
                          styles.lineCard,
                          {
                            backgroundColor: colors.bgElev,
                            borderColor: colors.line,
                          },
                        ]}
                      >
                        <Text
                          style={[styles.lineKind, { color: colors.textFaint }]}
                        >
                          {line.kind}
                        </Text>
                        <Field
                          label="Line"
                          value={line.description}
                          onChangeText={(description) =>
                            updateLine(line.id, { description })
                          }
                          colors={colors}
                        />
                        <Field
                          label="Amount"
                          keyboardType="decimal-pad"
                          value={(line.amountMinor / 100).toFixed(2)}
                          onChangeText={(amount) =>
                            updateLine(line.id, {
                              amountMinor: Math.round(
                                Number(amount || 0) * 100
                              ),
                            })
                          }
                          colors={colors}
                        />
                        <Text
                          style={[
                            styles.fieldLabel,
                            { color: colors.textSoft },
                          ]}
                        >
                          Allocate to
                        </Text>
                        <View style={styles.chips}>
                          {participantIds.map((partyId) => {
                            const selected = (
                              allocations[line.id] ?? participantIds
                            ).includes(partyId);
                            const party = parties.rows.find(
                              (row) => String(row.party_id) === partyId
                            );
                            return (
                              <Pressable
                                key={partyId}
                                accessibilityRole="checkbox"
                                accessibilityState={{ checked: selected }}
                                onPress={() =>
                                  toggleParticipant(line.id, partyId)
                                }
                                style={[
                                  styles.chip,
                                  {
                                    borderColor: selected
                                      ? colors.accent
                                      : colors.line,
                                  },
                                ]}
                              >
                                <Text style={{ color: colors.text }}>
                                  {String(
                                    party?.display_name ??
                                      (partyId ===
                                      String(
                                        vault.rows[0]?.owner_party_id ?? ""
                                      )
                                        ? "You"
                                        : "Member")
                                  )}
                                </Text>
                              </Pressable>
                            );
                          })}
                        </View>
                      </View>
                    ))}
                    <Text style={[styles.total, { color: colors.text }]}>
                      Reviewed total: {(receipt.amountMinor / 100).toFixed(2)}{" "}
                      {receipt.currency}
                    </Text>
                  </>
                ) : extraction ? (
                  <Field
                    label="Reviewed extracted text"
                    value={extraction.text}
                    multiline
                    onChangeText={(text) =>
                      setExtraction({ ...extraction, text })
                    }
                    colors={colors}
                  />
                ) : (
                  // Declined at the gate (issue #712 C3): stated inline,
                  // never a dead control — the field above simply doesn't
                  // exist for a scan with no extracted text.
                  <Text style={[styles.help, { color: colors.textSoft }]}>
                    {OCR_DECLINED_INLINE}
                  </Text>
                )}
                <PrimaryButton
                  label={busy ? "Saving…" : `Save to ${destination}`}
                  disabled={busy || !session}
                  onPress={() => void save()}
                  colors={colors}
                />
              </>
            ) : null}
          </>
        ) : (
          <>
            <View style={[styles.camera, { borderColor: colors.lineStrong }]}>
              {permission?.granted ? (
                <CameraView ref={camera} style={StyleSheet.absoluteFill} />
              ) : (
                <View style={styles.permission}>
                  <Text style={{ color: colors.textSoft }}>
                    Camera access is requested only when you choose Scan.
                  </Text>
                </View>
              )}
            </View>
            <PrimaryButton
              label={busy ? "Capturing…" : "Take photo"}
              disabled={busy}
              onPress={() => void takePhoto()}
              colors={colors}
            />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
