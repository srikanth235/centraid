import 'react-native-gesture-handler';
import { registerRootComponent } from 'expo';
import { AppRegistry } from 'react-native';
import { install as installQuickCrypto } from 'react-native-quick-crypto';

import App from './App';
import { drainUploadQueueInBackground } from './src/lib/upload/boot';

// Supply Hermes with native JSI SHA-256 plus WebCrypto AES-GCM/HMAC before
// the upload queue is evaluated (#419 M0 residue).
installQuickCrypto();

AppRegistry.registerHeadlessTask('CentraidUploadDrain', () => drainUploadQueueInBackground);

registerRootComponent(App);
