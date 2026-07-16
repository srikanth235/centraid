import { useEffect } from 'react';
import { Alert } from 'react-native';
import { useShareIntentContext } from 'expo-share-intent';
import { File } from 'expo-file-system';

import { backupDeviceMedia, backupDocument } from '../../lib/upload/media-producer';
import { useReplica } from '../replica/ReplicaProvider';

/** iOS share extension + Android share target converge on the one durable queue. */
export function ShareIntentIngest(): null {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const { session, gatewayBase } = useReplica();
  useEffect(() => {
    if (!hasShareIntent || !session || !gatewayBase || !shareIntent.files?.length) return;
    let cancelled = false;
    void (async () => {
      for (const file of shareIntent.files ?? []) {
        const plaintextSize = file.size ?? new File(file.path).size;
        if (file.mimeType.startsWith('image/') || file.mimeType.startsWith('video/')) {
          await backupDeviceMedia(session, gatewayBase, {
            localUri: file.path,
            filename: file.fileName,
            mediaType: file.mimeType,
            plaintextSize,
            kind: file.mimeType.startsWith('video/') ? 'video' : 'photo',
            width: file.width ?? undefined,
            height: file.height ?? undefined,
            durationS: file.duration ?? undefined,
          });
        } else {
          await backupDocument(session, gatewayBase, {
            localUri: file.path,
            title: file.fileName,
            mediaType: file.mimeType,
            plaintextSize,
          });
        }
      }
      if (!cancelled) resetShareIntent();
    })().catch((error) => {
      if (!cancelled)
        Alert.alert(
          'Save to Centraid paused',
          error instanceof Error ? error.message : String(error),
        );
    });
    return () => {
      cancelled = true;
    };
  }, [gatewayBase, hasShareIntent, resetShareIntent, session, shareIntent.files]);
  return null;
}
