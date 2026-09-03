import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { useReplica } from "../../kit/replica/ReplicaProvider";
import { photoTimelineEngine } from "./timeline-engine";
import type { TimelineSnapshot } from "./timeline-engine";

export type { PhotoAsset, PhotoSection } from "./timeline-model";

export function usePhotoTimeline(): TimelineSnapshot {
  const { session, gatewayBase } = useReplica();
  useEffect(() => photoTimelineEngine.acquire(), []);
  useEffect(() => {
    photoTimelineEngine.setSession(session, gatewayBase);
  }, [session, gatewayBase]);
  useFocusEffect(
    useCallback(() => {
      photoTimelineEngine.refreshUploads();
    }, [])
  );
  return useSyncExternalStore(
    photoTimelineEngine.subscribe,
    photoTimelineEngine.getSnapshot
  );
}
