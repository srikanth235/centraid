// One link row for Sharing.tsx (#726 P6) — the D9 receive setting and the
// per-link borrow-storage budget (gap 2), both tap-to-cycle to match this
// screen's existing component idiom (nothing here uses a TextInput/keyboard
// entry). Split out to keep Sharing.tsx under the repo's file-size guidance.
//
// `LinkTicketPanel` (below) is the one exception to "no TextInput": pasting
// a ticket someone showed you is external data, not a setting to cycle
// through, so it needs a real field.
import * as Clipboard from "expo-clipboard";
import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";

import { Text } from "../kit/components/NativeText";
import type { useTheme } from "../kit/theme";
import { density, radii, t } from "../kit/theme";
import {
  getBorrowBudget,
  getReceiveSetting,
  mintLinkTicket,
  redeemLinkTicket,
  setBorrowBudget,
  setReceiveSetting,
} from "../lib/replica/links-transport";
import type {
  BorrowBudget,
  GatewayLink,
  ReceiveSetting,
} from "../lib/replica/links-transport";

/** 1 GB in bytes — the UI's own display unit; the wire is always bytes. */
const GB = 1024 * 1024 * 1024;
/** Tap-to-cycle presets (#726 P6 gap 2). */
const BUDGET_PRESETS_GB = [1, 5, 20, 50, 100] as const;

export default function SharingLinkRow({
  link,
  label,
  busy,
  colors,
  gatewayBase,
  onApprove,
}: {
  link: GatewayLink;
  label: string;
  busy: boolean;
  colors: ReturnType<typeof useTheme>["colors"];
  gatewayBase?: string;
  onApprove: () => void;
}): React.JSX.Element {
  const [setting, setSetting] = useState<ReceiveSetting | undefined>();
  useEffect(() => {
    if (!gatewayBase) return;
    let live = true;
    getReceiveSetting(gatewayBase, link.linkId)
      .then((value) => {
        if (live) setSetting(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [gatewayBase, link.linkId]);

  const cycle = (): void => {
    if (!gatewayBase || !setting) return;
    const order: ReceiveSetting[] = ["accept", "ask", "refuse"];
    const next = order[(order.indexOf(setting) + 1) % order.length]!;
    setSetting(next);
    void setReceiveSetting(gatewayBase, link.linkId, next);
  };

  const [budget, setBudget] = useState<BorrowBudget | undefined>();
  useEffect(() => {
    if (!gatewayBase) return;
    let live = true;
    getBorrowBudget(gatewayBase, link.linkId)
      .then((value) => {
        if (live) setBudget(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [gatewayBase, link.linkId]);

  const cycleBudget = (): void => {
    if (!gatewayBase || !budget) return;
    const currentGb = budget.budgetBytes / GB;
    const nextGb =
      BUDGET_PRESETS_GB.find((gb) => gb > currentGb + 0.01) ??
      BUDGET_PRESETS_GB[0];
    const nextBytes = nextGb * GB;
    setBudget({ ...budget, budgetBytes: nextBytes, isDefault: false });
    void setBorrowBudget(gatewayBase, link.linkId, nextBytes);
  };

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.bgElev, borderColor: colors.line },
      ]}
    >
      <View style={styles.rowBetween}>
        <Text style={[t("body"), { color: colors.text }]}>{label}</Text>
        <Text style={[t("control"), { color: colors.textSoft }]}>
          {link.revoked ? "revoked" : link.approved ? "linked" : "pending"}
        </Text>
      </View>
      <Pressable accessibilityRole="button" disabled={!setting} onPress={cycle}>
        <Text style={[t("small"), { color: colors.textSoft }]}>
          Receive gives: {setting ?? "…"} (tap to change)
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        disabled={!budget}
        onPress={cycleBudget}
      >
        <Text style={[t("small"), { color: colors.textSoft }]}>
          Borrow budget:{" "}
          {budget ? `${(budget.budgetBytes / GB).toFixed(0)} GB` : "…"}
          {budget?.isDefault ? " (default)" : ""} (tap to change)
        </Text>
      </Pressable>
      {!link.approved && !link.revoked ? (
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={onApprove}
          style={[styles.pill, { borderColor: colors.line }]}
        >
          <Text style={[t("control"), { color: colors.accent }]}>Approve</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * The remote link ceremony's owner-facing door (#726 audit finding 1): mint
 * and show a one-time ticket, or paste one someone showed you. Text-only
 * here (no QR/camera scan yet — pasting is the reachable door this closes;
 * a scan affordance is a follow-up, not a gap in THIS surface).
 */
export function LinkTicketPanel({
  vaultId,
  colors,
  gatewayBase,
  onLinked,
}: {
  /** The device's own currently-mounted vault (mobile is single-vault-at-a-
   *  time, unlike the desktop household view — no picker needed). */
  vaultId?: string;
  colors: ReturnType<typeof useTheme>["colors"];
  gatewayBase?: string;
  onLinked: () => void;
}): React.JSX.Element {
  const [mode, setMode] = useState<"show" | "paste">("show");
  const [ticket, setTicket] = useState<string | undefined>();
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);

  const mint = async (): Promise<void> => {
    if (!gatewayBase || !vaultId) return;
    setBusy(true);
    setErrorMessage(undefined);
    try {
      const minted = await mintLinkTicket(gatewayBase, vaultId);
      setTicket(minted.ticket);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const copy = (): void => {
    if (!ticket) return;
    void Clipboard.setStringAsync(ticket).then(() => setCopied(true));
  };

  const redeem = async (): Promise<void> => {
    if (!gatewayBase || !vaultId || !pasted.trim()) return;
    setBusy(true);
    setErrorMessage(undefined);
    try {
      const outcome = await redeemLinkTicket(
        gatewayBase,
        vaultId,
        pasted.trim()
      );
      if (outcome.state === "linked") {
        setPasted("");
        onLinked();
      } else {
        setErrorMessage(
          outcome.detail ?? "That person could not be reached right now."
        );
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.bgElev, borderColor: colors.line },
      ]}
    >
      <View style={styles.rowActions}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: mode === "show" }}
          onPress={() => setMode("show")}
          style={[styles.pill, { borderColor: colors.line }]}
        >
          <Text style={[t("control"), { color: colors.accent }]}>
            Show my ticket
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: mode === "paste" }}
          onPress={() => setMode("paste")}
          style={[styles.pill, { borderColor: colors.line }]}
        >
          <Text style={[t("control"), { color: colors.accent }]}>
            Paste theirs
          </Text>
        </Pressable>
      </View>
      {mode === "show" ? (
        ticket ? (
          <>
            <Text
              selectable
              style={[t("small"), styles.ticketText, { color: colors.text }]}
            >
              {ticket}
            </Text>
            <View style={styles.rowActions}>
              <Pressable
                accessibilityRole="button"
                onPress={copy}
                style={[styles.pill, { borderColor: colors.line }]}
              >
                <Text style={[t("control"), { color: colors.accent }]}>
                  {copied ? "Copied" : "Copy"}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setTicket(undefined);
                  setCopied(false);
                }}
                style={[styles.pill, { borderColor: colors.line }]}
              >
                <Text style={[t("control"), { color: colors.textSoft }]}>
                  New ticket
                </Text>
              </Pressable>
            </View>
          </>
        ) : (
          <Pressable
            accessibilityRole="button"
            disabled={busy || !vaultId}
            onPress={() => void mint()}
            style={[styles.pill, { borderColor: colors.line }]}
          >
            <Text style={[t("control"), { color: colors.accent }]}>
              {busy ? "Generating…" : "Generate ticket"}
            </Text>
          </Pressable>
        )
      ) : (
        <>
          <TextInput
            accessibilityLabel="Pasted link ticket"
            multiline
            placeholder="Paste the ticket they showed you"
            placeholderTextColor={colors.textFaint}
            value={pasted}
            editable={!busy}
            onChangeText={setPasted}
            style={[
              styles.paste,
              { borderColor: colors.line, color: colors.text },
            ]}
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy || !vaultId || !pasted.trim()}
            onPress={() => void redeem()}
            style={[styles.pill, { borderColor: colors.line }]}
          >
            <Text style={[t("control"), { color: colors.accent }]}>
              {busy ? "Linking…" : "Link"}
            </Text>
          </Pressable>
        </>
      )}
      {errorMessage ? (
        <Text style={[t("small"), { color: colors.danger }]}>
          {errorMessage}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: 6,
    padding: density.comfortable.pad,
  },
  paste: {
    borderRadius: radii.md,
    borderWidth: 1,
    fontFamily: "monospace",
    minHeight: 64,
    padding: 8,
  },
  pill: {
    alignSelf: "flex-start",
    borderRadius: radii.md,
    borderWidth: 1,
    marginTop: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  rowActions: { flexDirection: "row", gap: 8 },
  rowBetween: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  ticketText: { fontFamily: "monospace" },
});
