import { createHash } from "react-native-quick-crypto";

import type { StreamingDigest } from "./enqueue";

export function createNativeDigest(): StreamingDigest {
  const hash = createHash("sha256");
  return {
    update(bytes) {
      hash.update(bytes);
    },
    digestHex() {
      return hash.digest("hex");
    },
  };
}
