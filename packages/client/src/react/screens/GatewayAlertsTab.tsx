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

export interface GatewayAlertsTabProps {
  snapshot: GatewayRuntimeSnapshot;
  savingAlert?: boolean;
  onAlertSecondsChange?: (seconds: number) => void;
  onAlertsEnabledChange?: (enabled: boolean) => void;
  launchAtLogin?: boolean;
  onLaunchAtLoginChange?: (enabled: boolean) => void;
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
