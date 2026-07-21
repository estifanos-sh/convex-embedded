import * as ExpoCrypto from "expo-crypto";

import { installExpoCrypto } from "./cryptography";

installExpoCrypto(globalThis, {
  digest: async (_algorithm, data) =>
    await ExpoCrypto.digest(ExpoCrypto.CryptoDigestAlgorithm.SHA256, data),
  getRandomValues: (value) => ExpoCrypto.getRandomValues(value),
  randomUUID: () => ExpoCrypto.randomUUID(),
});
