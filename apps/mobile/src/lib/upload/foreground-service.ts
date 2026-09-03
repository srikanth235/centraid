import { NativeModules, Platform } from "react-native";

interface NativeUploadForegroundModule {
  start: (total: number) => void;
  update: (completed: number, total: number) => void;
  stop: () => void;
}

const native = NativeModules.CentraidUploadForeground as
  | NativeUploadForegroundModule
  | undefined;

let owners = 0;

export const UploadForegroundService = {
  start(total: number): void {
    if (Platform.OS !== "android" || total <= 0) return;
    owners += 1;
    if (owners === 1) native?.start(total);
  },
  update(completed: number, total: number): void {
    if (Platform.OS === "android" && owners > 0)
      native?.update(completed, total);
  },
  stop(): void {
    if (Platform.OS !== "android" || owners === 0) return;
    owners -= 1;
    if (owners === 0) native?.stop();
  },
};
