export interface OptimisticUpdate<T> {
  read: () => T;
  write: (next: T) => void;
  apply: (previous: T) => T;
  commit: () => Promise<unknown>;
  settle?: () => Promise<void>;
}

export async function optimisticUpdate<T>(
  update: OptimisticUpdate<T>
): Promise<void> {
  const before = update.read();
  update.write(update.apply(before));
  try {
    await update.commit();
  } catch (error) {
    update.write(before);
    throw error;
  }
  if (update.settle) await update.settle();
}
