import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { useShareIntentContext } from 'expo-share-intent';
import { File } from 'expo-file-system';

import { backupDeviceMedia, backupDocument } from '../../lib/upload/media-producer';
import { useReplica } from '../replica/ReplicaProvider';
import { ShareIntentGate, processShareIntent } from './share-ingest';

/** iOS share extension + Android share target converge on the one durable queue. */
export function ShareIntentIngest(): null {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const { session, gatewayBase } = useReplica();
  // One gate across renders: a re-render while an ingest is still in flight must
  // not spawn a second pass over the same files (#431 F9).
  const gateRef = useRef<ShareIntentGate | null>(null);
  if (!gateRef.current) gateRef.current = new ShareIntentGate();
  useEffect(() => {
    if (!hasShareIntent || !session || !gatewayBase) return;
    void gateRef.current!.run(() =>
      processShareIntent(
        {
          backupDeviceMedia,
          backupDocument,
          fileSize: (path) => new File(path).size,
          reset: resetShareIntent,
          alert: (title, message) => Alert.alert(title, message),
        },
        session,
        gatewayBase,
        shareIntent,
      ),
    );
  }, [gatewayBase, hasShareIntent, resetShareIntent, session, shareIntent]);
  return null;
}
