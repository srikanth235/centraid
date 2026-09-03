import * as Crypto from "expo-crypto";

import type {
  ReplicaDigest,
  ReplicaIdFactory,
} from "@centraid/client/replica/native";

export const nativeReplicaDigest: ReplicaDigest = (input) =>
  Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input);

export const nativeReplicaIdFactory: ReplicaIdFactory = () =>
  Crypto.randomUUID();
