import { useCallback, useEffect, useState } from "react";

import { COMPOSE_OUTCOMES } from "./compose-copy.ts";
import { exportFile, saveExportFile } from "./export-file.ts";
import { EXPORT } from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import type { ExportData } from "./types.ts";

export interface ExportRead {
  data: ExportData | null;
  save: () => void;
}

export function rangeSince(
  range: string,
  now: Date = new Date()
): string | null {
  const year = String(now.getFullYear()).padStart(4, "0");
  if (range === "year") return `${year}-01-01`;
  if (range === "month")
    return `${year}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  return null;
}

export function useExportRead(args: {
  shelf: ShelfId;
  groupId: string | null;
  range: string;
  format: string;
  say: (text: string) => void;
}): ExportRead {
  const { shelf, groupId, range, format, say } = args;
  const [held, setHeld] = useState<{
    forGroup: string;
    forRange: string;
    data: ExportData | null;
  } | null>(null);

  const wanted = shelf === EXPORT ? groupId : null;

  useEffect(() => {
    if (wanted === null) return;
    let live = true;
    void (async () => {
      let data: ExportData | null = null;
      const since = rangeSince(range);
      try {
        data = await window.centraid.read<ExportData>({
          query: "export",
          input: { group_id: wanted, ...(since === null ? {} : { since }) },
        });
      } catch {
        data = null;
      }
      if (live) setHeld({ forGroup: wanted, forRange: range, data });
    })();
    return () => {
      live = false;
    };
  }, [wanted, range]);

  const data =
    held && held.forGroup === wanted && held.forRange === range
      ? held.data
      : null;

  const save = useCallback(() => {
    if (!data) return;
    saveExportFile(exportFile(data, format));
    say(COMPOSE_OUTCOMES.exported);
  }, [data, format, say]);

  return { data, save };
}
