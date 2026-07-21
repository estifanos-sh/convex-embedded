interface CryptoProvider {
  digest(algorithm: "SHA-256", data: BufferSource): Promise<ArrayBuffer>;
  getRandomValues<T extends Uint8Array>(typedArray: T): T;
  randomUUID(): string;
}

interface CryptoTarget {
  crypto?: Crypto;
}

/** Install the Web Crypto subset used by the embedded runtime on Hermes. @internal */
export function installExpoCrypto(target: CryptoTarget, provider: CryptoProvider): void {
  const current = target.crypto as unknown as
    | {
        getRandomValues?: Crypto["getRandomValues"];
        randomUUID?: Crypto["randomUUID"];
        subtle?: { digest?: SubtleCrypto["digest"] };
      }
    | undefined;
  const getRandomValues =
    current?.getRandomValues?.bind(current) ??
    (<T extends ArrayBufferView>(value: T): T => {
      provider.getRandomValues(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      return value;
    });
  const randomUUID = current?.randomUUID?.bind(current) ?? (() => provider.randomUUID());
  const digest =
    current?.subtle?.digest?.bind(current.subtle) ??
    ((algorithm: AlgorithmIdentifier, data: BufferSource) => {
      const name = typeof algorithm === "string" ? algorithm : algorithm.name;
      if (name.toUpperCase().replaceAll("-", "") !== "SHA256") {
        return Promise.reject(new Error(`Unsupported Expo crypto digest algorithm: ${name}`));
      }
      return provider.digest("SHA-256", data);
    });

  if (current?.getRandomValues && current.randomUUID && current.subtle?.digest) return;
  const installed = current ?? {};
  if (!current?.getRandomValues) define(installed, "getRandomValues", getRandomValues);
  if (!current?.randomUUID) define(installed, "randomUUID", randomUUID);
  if (!current?.subtle) {
    define(installed, "subtle", { digest });
  } else if (!current.subtle.digest) {
    define(current.subtle, "digest", digest);
  }
  if (!current) define(target, "crypto", installed as Crypto);
}

function define(target: object, property: PropertyKey, value: unknown): void {
  Object.defineProperty(target, property, { configurable: true, value, writable: true });
}
