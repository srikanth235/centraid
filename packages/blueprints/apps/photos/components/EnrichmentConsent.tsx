import { ConsentGate } from "../../_shared/ConsentGate.tsx";
import {
  CLOUD_PANEL,
  ENRICHMENT_NOTE,
  ON_DEVICE_PANEL,
  onDeviceTitle,
} from "../enrichment-consent.ts";
import type { AnswerAvailability } from "../enrichment-consent.ts";

export interface EnrichmentConsentProps {
  count: number | null;
  onDevice: AnswerAvailability;
  cloud: AnswerAvailability;
  busy?: boolean;
  answered?: "device" | "declined" | null;
  onRunOnDevice: () => void;
  onDecline: () => void;
  onChooseCloud?: () => void;
}

export function EnrichmentConsent({
  count,
  onDevice,
  cloud,
  busy,
  answered,
  onRunOnDevice,
  onDecline,
  onChooseCloud,
}: EnrichmentConsentProps) {
  return (
    <ConsentGate
      domain="photos"
      onDevicePanel={ON_DEVICE_PANEL}
      onDeviceTitle={count == null ? undefined : onDeviceTitle(count)}
      onDevice={onDevice}
      netPanel={CLOUD_PANEL}
      net={cloud}
      note={ENRICHMENT_NOTE}
      busy={busy}
      answered={answered}
      onRunOnDevice={onRunOnDevice}
      onDecline={onDecline}
      onChooseNet={onChooseCloud}
    />
  );
}
