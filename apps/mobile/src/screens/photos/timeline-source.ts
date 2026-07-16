// M0.5 seam — the boundary where the native Photos timeline mounts.
//
// The real gallery lands in M1: this hook will read the on-device replica
// (src/lib/replica, built separately) and surface backed-up media as a
// sectioned, date-grouped timeline. For now it always reports `empty`, which
// PhotosHome renders as a themed placeholder. M1 replaces only this hook's
// body — PhotosHome switches on `kind`, so the screen shell stays put.

export type PhotoTimeline =
  | { kind: 'empty' }
  | { kind: 'loading' }
  // M1 fills this in (sections of media grouped by day). Shape intentionally
  // left open so the replica module can define the concrete row type.
  | { kind: 'ready'; sections: readonly unknown[] };

export function usePhotoTimeline(): PhotoTimeline {
  return { kind: 'empty' };
}
