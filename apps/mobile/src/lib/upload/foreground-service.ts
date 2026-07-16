import { NativeModules, Platform } from 'react-native';

interface NativeUploadForegroundModule {
  start(total: number): void;
  update(completed: number, total: number): void;
  stop(): void;
}

const native = NativeModules.CentraidUploadForeground as NativeUploadForegroundModule | undefined;

export const UploadForegroundService = {
  start(total: number): void {
    if (Platform.OS === 'android' && total > 0) native?.start(total);
  },
  update(completed: number, total: number): void {
    if (Platform.OS === 'android') native?.update(completed, total);
  },
  stop(): void {
    if (Platform.OS === 'android') native?.stop();
  },
};
