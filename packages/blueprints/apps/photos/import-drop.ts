interface DropReader {
  readEntries: (
    ok: (entries: DropEntry[]) => void,
    err?: (error: Error) => void
  ) => void;
}

interface DropEntry {
  isFile: boolean;
  isDirectory: boolean;
  file: (ok: (file: File) => void, err?: (error: Error) => void) => void;
  createReader: () => DropReader;
}

function asDropEntry(item: DataTransferItem): DropEntry | null {
  const get = (
    item as DataTransferItem & {
      webkitGetAsEntry?: () => DropEntry | null;
    }
  ).webkitGetAsEntry;
  return get?.call(item) ?? null;
}

function readEntryBatch(reader: DropReader): Promise<DropEntry[]> {
  return new Promise((resolve, reject) => {
    reader.readEntries(resolve, reject);
  });
}

async function readAllEntries(reader: DropReader): Promise<DropEntry[]> {
  const batch = await readEntryBatch(reader);
  if (batch.length === 0) return [];
  return [...batch, ...(await readAllEntries(reader))];
}

async function filesFromEntry(entry: DropEntry): Promise<File[]> {
  if (entry.isFile) {
    return [
      await new Promise<File>((resolve, reject) => {
        entry.file(resolve, reject);
      }),
    ];
  }
  if (!entry.isDirectory) return [];
  const children = await readAllEntries(entry.createReader());
  return (await Promise.all(children.map(filesFromEntry))).flat();
}

export async function filesFromDataTransfer(
  dataTransfer: DataTransfer | null | undefined
): Promise<File[]> {
  if (!dataTransfer) return [];
  const listed = Array.from(dataTransfer.files ?? []);
  const fromItems: File[] = [];
  const entries: DropEntry[] = [];
  for (const item of dataTransfer.items ?? []) {
    const entry = asDropEntry(item);
    if (entry) {
      entries.push(entry);
      continue;
    }
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  const walked =
    entries.length > 0
      ? (await Promise.all(entries.map(filesFromEntry))).flat()
      : fromItems;
  if (walked.length >= listed.length && walked.length > 0) return walked;
  return listed;
}
