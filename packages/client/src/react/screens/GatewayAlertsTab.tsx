import type { JSX } from "react";

import {
  ALERT_PRESETS,
  buildAlertHistoryRows,
  thresholdLabel,
} from "../shell/routes/gatewayData.js";
import type { GatewayRuntimeSnapshot } from "../shell/routes/gatewayData.js";
import ChipsBlock from "../ui/ChipsBlock.js";
import EmptyBlock from "../ui/EmptyBlock.js";
import NoteBlock from "../ui/NoteBlock.js";
import RowsBlock from "../ui/RowsBlock.js";
import type { RowDef } from "../ui/RowsBlock.js";
import SectionBlock from "../ui/SectionBlock.js";

import styles from "./GatewayScreen.module.css";

// System → Alert history (binding layer v11). Two statements, in the order
// they are asked: what this gateway has already raised, and when it should
// raise the next one.
//
// NOT BORDERED CARDS WITH THEIR HEADS INSIDE THEM, and not a bespoke switch
// or a second copy of one. The heads sit above their containers, the ladder is
// the kit's chip picker, the history is rows whose meta is the alert's own
// state, and each switch is a row that STATES what it is doing and offers the
// one verb that changes it. A row
// reading "Alert when unreachable · on · [Turn off]" says in the reading order
// what a track-and-knob says only to someone who already knows the convention.
//
// The prototype's own note is kept: a thing that keeps clearing itself is a
// pattern, and the pattern is the finding.

export interface GatewayAlertsTabProps {
  snapshot: GatewayRuntimeSnapshot;
  /** True while a settings write is in flight — the alert card locks. */
  savingAlert?: boolean;
  onAlertSecondsChange?: (seconds: number) => void;
  onAlertsEnabledChange?: (enabled: boolean) => void;
  /** Optional launch-at-login toggle; defaults false for older hosts/tests. */
  launchAtLogin?: boolean;
  onLaunchAtLoginChange?: (enabled: boolean) => void;
  /** True while the launch-at-login write is in flight — locks just that switch. */
  savingLaunchAtLogin?: boolean;
  readOnly?: boolean;
}

export default function GatewayAlertsTab(
  props: GatewayAlertsTabProps
): JSX.Element {
  const { snapshot } = props;
  const alert = snapshot.alert;
  const hasPreset = ALERT_PRESETS.some(
    (p) => p.seconds === alert.thresholdSeconds
  );
  const rows = buildAlertHistoryRows(snapshot);
  const cleared = rows.filter((row) => row.kind === "recovered").length;
  const launchAtLogin = props.launchAtLogin ?? false;

  // WHEN, not what: the history head counts what is on record, and how much of
  // it resolved without anyone doing anything.
  const historyMeta =
    rows.length === 0
      ? "nothing raised yet"
      : cleared === 0
        ? `${rows.length} · none cleared themselves`
        : `${rows.length} · ${cleared} cleared themselves`;

  const settings: RowDef[] = [
    {
      id: "down-alert",
      meta: alert.enabled ? "on" : "off",
      sub: "One system notification per outage, and one when the gateway comes back.",
      title: "Alert when unreachable",
      ...(props.readOnly
        ? {}
        : {
            action: {
              hint: "Turn the down alert on or off",
              label: alert.enabled ? "Turn off" : "Turn on",
              onClick: () => props.onAlertsEnabledChange?.(!alert.enabled),
              ...(props.savingAlert ? { off: true } : {}),
            },
          }),
    },
  ];
  if (!props.readOnly)
    settings.push({
      id: "launch-at-login",
      meta: launchAtLogin ? "on" : "off",
      sub: "Keeps your gateway available without having to open Centraid by hand.",
      title: "Start Centraid at login",
      action: {
        hint: "Start Centraid when you log in",
        label: launchAtLogin ? "Turn off" : "Turn on",
        onClick: () => props.onLaunchAtLoginChange?.(!launchAtLogin),
        ...(props.savingLaunchAtLogin ? { off: true } : {}),
      },
    });

  return (
    <div className={styles.tabPane}>
      <SectionBlock label="Alert history" meta={historyMeta} />
      {rows.length === 0 ? (
        <EmptyBlock
          routine
          title="No alerts yet."
          body="Outages, recoveries, component errors and version mismatches land here, and stay across restarts."
        />
      ) : (
        <div data-testid="alert-history-panel">
          <RowsBlock
            ariaLabel="Alert history"
            rows={rows.map((row) => ({
              id: row.id,
              meta: row.previousSession ? "earlier session" : row.kindLabel,
              sub: [
                `raised ${row.timeLabel}`,
                row.detail,
                row.durationLabel ? `lasted ${row.durationLabel}` : undefined,
              ]
                .filter(Boolean)
                .join(" · "),
              title: row.kindLabel,
              ...(row.kind === "down" || row.kind === "component-error"
                ? { net: true }
                : {}),
            }))}
          />
        </div>
      )}
      <NoteBlock>
        An alert that cleared itself is kept, because a thing that keeps
        clearing itself is a pattern and the pattern is the finding.
      </NoteBlock>

      <SectionBlock
        label="When to tell you"
        meta={
          alert.enabled
            ? `after ${thresholdLabel(alert.thresholdSeconds)} unreachable`
            : "down alerts are off"
        }
      />
      <RowsBlock ariaLabel="When to tell you" rows={settings} />
      {/* The ladder is a picker, so it is the kit's chip group rather than a
          row of bespoke buttons. Absent while the alert is off: a threshold
          for a notification nobody will get is a control that does nothing. */}
      {!props.readOnly && alert.enabled ? (
        <ChipsBlock
          ariaLabel="Alert after unreachable for"
          chips={[
            ...ALERT_PRESETS.map((preset) => ({
              id: String(preset.seconds),
              label: preset.label,
              on: preset.seconds === alert.thresholdSeconds,
            })),
            ...(hasPreset
              ? []
              : [
                  {
                    id: String(alert.thresholdSeconds),
                    label: thresholdLabel(alert.thresholdSeconds),
                    on: true,
                  },
                ]),
          ]}
          mono
          onPick={(id) => props.onAlertSecondsChange?.(Number(id))}
        />
      ) : null}
    </div>
  );
}
