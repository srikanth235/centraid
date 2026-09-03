import { useCallback, useMemo } from "react";
import type { RefObject } from "react";

import type { Bag } from "./bag.ts";
import { exportCsv, exportFileName, saveExportFile } from "./export-file.ts";
import type { ExportPayload } from "./export-file.ts";
import { draftBatches, publishedCopy } from "./import-model.ts";
import type { StagedBatch, StagedRow } from "./import-model.ts";
import {
  EXPORT_NOTHING,
  EXPORT_PARKED,
  EXPORT_WRITTEN,
  IMPORT_DISCARDED,
  IMPORT_STAGED,
} from "./route-copy.ts";
import type { LockerAccessEntry } from "./types.ts";
import { exportWrite } from "./writes.ts";

export function importDoorPresent(): boolean {
  const client = window.centraid as unknown as Record<string, unknown>;
  return (
    typeof client?.stageImport === "function" &&
    typeof client?.importBatches === "function" &&
    typeof client?.importRows === "function" &&
    typeof client?.publishImport === "function" &&
    typeof client?.discardImport === "function"
  );
}

type ImportClient = {
  stageImport?: (file: File) => Promise<{ batchId: string }>;
  importBatches?: () => Promise<StagedBatch[]>;
  importRows?: (batchId: string) => Promise<StagedRow[]>;
  publishImport?: (batchId: string) => Promise<{
    created?: number;
    updated?: number;
    skipped?: number;
    failed?: unknown[];
  }>;
  discardImport?: (batchId: string) => Promise<{ receiptId: string }>;
};

function importClient(): ImportClient {
  return window.centraid as unknown as ImportClient;
}

export interface SurfaceActsInput {
  bagRef: RefObject<Bag>;
  bump: () => void;
  publish: (text: string) => void;
  refresh: () => Promise<void>;
}

export interface SurfaceActs {
  handleLoadAccess: (itemId: string | null) => Promise<void>;
  handleNarrowAccess: (itemId: string | null) => void;
  handleLoadBatches: () => Promise<void>;
  handleStageFile: (file: File) => void;
  handleOpenBatch: (batchId: string) => void;
  handlePublishBatch: (batchId: string) => void;
  handleDiscardBatch: (batchId: string) => void;
  handleExportOption: (option: "trashed" | "history", on: boolean) => void;
  handleAskExport: () => void;
  handleCancelExport: () => void;
  handleRunExport: () => void;
}

export function useSurfaceActs(input: SurfaceActsInput): SurfaceActs {
  const { bagRef, bump, publish, refresh } = input;

  const handleLoadAccess = useCallback(
    async (itemId: string | null): Promise<void> => {
      const token = bagRef.current.sessionToken;
      if (!token) return;
      try {
        const payload = await window.centraid.read<{
          entries?: LockerAccessEntry[];
          window?: number;
          truncated?: boolean;
          authRequired?: boolean;
          vaultDenied?: unknown;
        }>({
          query: "access",
          input: {
            auth_session: token,
            ...(itemId ? { item_id: itemId } : {}),
          },
        });
        if (payload?.authRequired || payload?.vaultDenied) {
          bagRef.current.accessEntries = null;
          bagRef.current.accessWindow = null;
        } else {
          bagRef.current.accessEntries = payload?.entries ?? [];
          bagRef.current.accessWindow = {
            window: payload?.window ?? 0,
            truncated: Boolean(payload?.truncated),
          };
        }
      } catch {
        bagRef.current.accessEntries = null;
        bagRef.current.accessWindow = null;
      }
      bump();
    },
    [bagRef, bump]
  );

  const handleNarrowAccess = useCallback(
    (itemId: string | null): void => {
      bagRef.current.accessItemId = itemId;
      bagRef.current.accessEntries = null;
      bump();
      void handleLoadAccess(itemId);
    },
    [bagRef, bump, handleLoadAccess]
  );

  const handleLoadBatches = useCallback(async (): Promise<void> => {
    if (!importDoorPresent()) return;
    try {
      const batches = (await importClient().importBatches?.()) ?? [];
      bagRef.current.importBatches = draftBatches(batches);
    } catch (error) {
      bagRef.current.importBatches = [];
      bagRef.current.importNote = String(
        (error as { message?: string })?.message ?? error
      );
    }
    bump();
  }, [bagRef, bump]);

  const handleOpenBatch = useCallback(
    (batchId: string): void => {
      bagRef.current.openBatchId = batchId;
      bagRef.current.importRows = null;
      bump();
      void importClient()
        .importRows?.(batchId)
        .then((rows) => {
          bagRef.current.importRows = rows ?? [];
          bump();
        })
        .catch((error: unknown) => {
          bagRef.current.importNote = String(
            (error as { message?: string })?.message ?? error
          );
          bump();
        });
    },
    [bagRef, bump]
  );

  const handleStageFile = useCallback(
    (file: File): void => {
      bagRef.current.importNote = "";
      bump();
      void importClient()
        .stageImport?.(file)
        .then((staged) => {
          bagRef.current.importNote = IMPORT_STAGED;
          bump();
          void handleLoadBatches();
          if (staged?.batchId) handleOpenBatch(staged.batchId);
        })
        .catch((error: unknown) => {
          bagRef.current.importNote = String(
            (error as { message?: string })?.message ?? error
          );
          bump();
        });
    },
    [bagRef, bump, handleLoadBatches, handleOpenBatch]
  );

  const handlePublishBatch = useCallback(
    (batchId: string): void => {
      void importClient()
        .publishImport?.(batchId)
        .then((result) => {
          bagRef.current.importNote = publishedCopy(result ?? {});
          bagRef.current.openBatchId = null;
          bagRef.current.importRows = null;
          publish(bagRef.current.importNote);
          bump();
          void handleLoadBatches();
          void refresh();
        })
        .catch((error: unknown) => {
          bagRef.current.importNote = String(
            (error as { message?: string })?.message ?? error
          );
          bump();
        });
    },
    [bagRef, bump, handleLoadBatches, publish, refresh]
  );

  const handleDiscardBatch = useCallback(
    (batchId: string): void => {
      void importClient()
        .discardImport?.(batchId)
        .then(() => {
          bagRef.current.importNote = IMPORT_DISCARDED;
          bagRef.current.openBatchId = null;
          bagRef.current.importRows = null;
          publish(IMPORT_DISCARDED);
          bump();
          void handleLoadBatches();
        })
        .catch((error: unknown) => {
          bagRef.current.importNote = String(
            (error as { message?: string })?.message ?? error
          );
          bump();
        });
    },
    [bagRef, bump, handleLoadBatches, publish]
  );

  const handleExportOption = useCallback(
    (option: "trashed" | "history", on: boolean): void => {
      if (option === "trashed") bagRef.current.exportTrashed = on;
      else bagRef.current.exportHistory = on;
      bump();
    },
    [bagRef, bump]
  );

  const handleAskExport = useCallback((): void => {
    bagRef.current.exportConfirm = true;
    bump();
  }, [bagRef, bump]);

  const handleCancelExport = useCallback((): void => {
    bagRef.current.exportConfirm = false;
    bump();
  }, [bagRef, bump]);

  const handleRunExport = useCallback((): void => {
    bagRef.current.exportConfirm = false;
    bump();
    const write = exportWrite({
      ...(bagRef.current.exportTrashed ? { includeTrashed: true } : {}),
      ...(bagRef.current.exportHistory ? { includeHistory: true } : {}),
    });
    void (async () => {
      let settled: VaultOutcome | undefined;
      try {
        settled = await window.centraid.write(write);
      } catch (error) {
        publish(String((error as { message?: string })?.message ?? error));
        return;
      }
      if (settled?.status === "parked") {
        publish(EXPORT_PARKED);
        return;
      }
      const payload = (settled?.output ?? null) as ExportPayload | null;
      if (!payload?.items) {
        publish(EXPORT_NOTHING);
        return;
      }
      saveExportFile({
        name: exportFileName(payload),
        text: exportCsv(payload),
        type: "text/csv",
      });
      publish(EXPORT_WRITTEN);
    })();
  }, [bagRef, bump, publish]);

  return useMemo(
    () => ({
      handleLoadAccess,
      handleNarrowAccess,
      handleLoadBatches,
      handleStageFile,
      handleOpenBatch,
      handlePublishBatch,
      handleDiscardBatch,
      handleExportOption,
      handleAskExport,
      handleCancelExport,
      handleRunExport,
    }),
    [
      handleLoadAccess,
      handleNarrowAccess,
      handleLoadBatches,
      handleStageFile,
      handleOpenBatch,
      handlePublishBatch,
      handleDiscardBatch,
      handleExportOption,
      handleAskExport,
      handleCancelExport,
      handleRunExport,
    ]
  );
}
