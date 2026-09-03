import "react-native-gesture-handler";
import { registerRootComponent } from "expo";
import { AppRegistry } from "react-native";
import { install as installQuickCrypto } from "react-native-quick-crypto";

import App from "./App";
import { registerReplicaBackgroundTasks } from "./src/lib/replica/background-sync";
import { drainUploadQueueInBackground } from "./src/lib/upload/boot";

installQuickCrypto();

AppRegistry.registerHeadlessTask(
  "CentraidUploadDrain",
  () => drainUploadQueueInBackground
);
void registerReplicaBackgroundTasks();

registerRootComponent(App);
