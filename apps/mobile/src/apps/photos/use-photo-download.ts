import { useRef, useState } from "react";

import type { SelectionHandler } from "@centraid/blueprints/apps/_shared/selection-engine";

import { postStatus } from "../../kit/components/status-line";
import { currentNetworkType } from "../../kit/fetch-gate/network";
import { authHeader } from "../../lib/gateway";
import {
  batchDownload,
  downloadStatus,
  downloadableAssets,
  NOTHING_TO_DOWNLOAD_REASON,
} from "./photos-selection-writes";
import type { VaultAsset } from "./photos-selection-writes";

const OFFLINE_REASON =
  "Originals live on the gateway, and this phone cannot reach it right now.";
const RUNNING_STATUS = "Downloading originals…";

export interface SelectionDownloadInput {
  targets: () => readonly VaultAsset[];
  online: boolean;
}

export function useSelectionDownload({
  targets,
  online,
}: SelectionDownloadInput): SelectionHandler {
  const [running, setRunning] = useState(false);
  const consentedFor = useRef<string | undefined>(undefined);

  const run = (): void => {
    const candidates = downloadableAssets(targets());
    if (candidates.length === 0) {
      postStatus(NOTHING_TO_DOWNLOAD_REASON);
      return;
    }
    const signature = candidates
      .map((asset) => asset.contentId)
      .sort()
      .join("\u0000");
    setRunning(true);
    postStatus(RUNNING_STATUS);
    void (async () => {
      try {
        const summary = await batchDownload(candidates, {
          headers: authHeader(),
          networkType: await currentNetworkType(),
          consented: consentedFor.current === signature,
          online,
        });
        consentedFor.current = summary.needsChoice > 0 ? signature : undefined;
        postStatus(downloadStatus(summary));
      } finally {
        setRunning(false);
      }
    })();
  };

  if (!online) return { unavailableReason: OFFLINE_REASON };
  if (running) return { unavailableReason: RUNNING_STATUS };
  return { run };
}
