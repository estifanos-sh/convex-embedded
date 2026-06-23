export function localStorageId(): string {
  const crypto = globalThis.crypto as { getRandomValues?: (array: Uint8Array) => Uint8Array };
  const bytes = new Uint8Array(16);
  if (typeof crypto?.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return `_storage|${hex(bytes)}`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const crypto = globalThis.crypto as
    | { subtle?: { digest(algorithm: "SHA-256", data: ArrayBuffer): Promise<ArrayBuffer> } }
    | undefined;
  if (!crypto?.subtle) {
    throw new Error("Convex embedded file storage requires crypto.subtle.digest for sha256.");
  }
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", copyArrayBuffer(bytes))));
}

export function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}
