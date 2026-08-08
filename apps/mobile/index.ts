import "react-native-gesture-handler";
import { registerRootComponent } from "expo";
import { AppRegistry, LogBox } from "react-native";
import { install as installQuickCrypto } from "react-native-quick-crypto";

import App from "./App";
import { registerReplicaBackgroundTasks } from "./src/lib/replica/background-sync";
import { drainUploadQueueInBackground } from "./src/lib/upload/boot";

// Dev LogBox toasts can sit over the bottom edge of onboarding and steal a
// Maestro tap from the control underneath. Keep warnings in Metro's console;
// the native E2E driver must see the actual product hierarchy.
if (__DEV__) {
  LogBox.ignoreAllLogs(true);
}

// Supply Hermes with native JSI SHA-256 plus WebCrypto AES-GCM/HMAC before
// the upload queue is evaluated (#419 M0 residue).
installQuickCrypto();

AppRegistry.registerHeadlessTask(
  "CentraidUploadDrain",
  () => drainUploadQueueInBackground
);
void registerReplicaBackgroundTasks();

registerRootComponent(App);
