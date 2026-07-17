import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useFocusEffect } from '@react-navigation/native';

import { useReplica } from '../../kit/replica/ReplicaProvider';
import { photoTimelineEngine, type TimelineSnapshot } from './timeline-engine';
export type { BackupState, PhotoAsset, PhotoSection } from './timeline-model';

/**
 * Read the one shared timeline (see `timeline-engine.ts`). Every Photos screen
 * calls this, but they all observe a single engine — one replica read, one
 * MediaLibrary walk — instead of each spinning up its own. The returned
 * snapshot is referentially stable until the underlying data changes, so
 * downstream memos hold.
 */
export function usePhotoTimeline(): TimelineSnapshot {
  const { session, gatewayBase } = useReplica();
  // Mount lifecycle (ref count) and session updates are separate effects: a
  // gateway-base change must not bounce the ref count and re-walk the library.
  useEffect(() => photoTimelineEngine.acquire(), []);
  useEffect(() => {
    photoTimelineEngine.setSession(session, gatewayBase);
  }, [session, gatewayBase]);
  // Backup badges are driven by a separate upload-queue db; re-read it whenever
  // a screen regains focus so queued → backed-up flips are picked up promptly.
  useFocusEffect(
    useCallback(() => {
      photoTimelineEngine.refreshUploads();
    }, []),
  );
  return useSyncExternalStore(photoTimelineEngine.subscribe, photoTimelineEngine.getSnapshot);
}
