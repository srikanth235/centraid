import "react-native-gesture-handler";
import { registerRootComponent } from "expo";
import { AppRegistry, LogBox } from "react-native";
import { install as installQuickCrypto } from "react-native-quick-crypto";

import App from "./App";
import { registerReplicaBackgroundTasks } from "./src/lib/replica/background-sync";
import { drainUploadQueueInBackground } from "./src/lib/upload/boot";

// Dev LogBox toast parks on the bottom edge and steals Maestro taps from
// onboarding paste / the home dock (iOS home-loads 30716166878; see also
// native-v0-resilience.mjs). Keep warnings in the Metro console; suppress the
// on-device overlay so XCUITest hits the control underneath.
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
