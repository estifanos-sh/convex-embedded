import { describe, expect, test, vi } from "vite-plus/test";

import { decodeRequest, decodeResponse, encodeRequest } from "../../src/expo/codec";
import { installExpoCrypto } from "../../src/expo/cryptography";
import { createNativeModuleLoader, type NativeModule } from "../../src/expo/module";

describe("Expo native bridge", () => {
  test("encodes positional arguments, bytes, and exact integers", () => {
    const request = decodeRequest(
      encodeRequest("blobWrite", ["blob", new Uint8Array([1, 2, 3]), 9_007_199_254_740_993n]),
    );

    expect(request).toEqual({
      buffers: [new Uint8Array([1, 2, 3])],
      json: '["blob",{"$buffer":0},{"$integer":"9007199254740993"}]',
      operation: "blobWrite",
      version: 1,
    });
  });

  test("preserves every special float bit pattern through JSON", () => {
    const request = decodeRequest(encodeRequest("commit", [Number.NaN, Infinity, -Infinity, -0]));
    expect(JSON.parse(request.json)).toEqual([
      { $float: "7ff8000000000000" },
      { $float: "7ff0000000000000" },
      { $float: "fff0000000000000" },
      { $float: "8000000000000000" },
    ]);
  });

  test("loads once and rejects missing or stale native modules", () => {
    const native = module(1);
    const resolve = vi.fn(() => native);
    const load = createNativeModuleLoader(resolve);

    expect(load()).toBe(native);
    expect(load()).toBe(native);
    expect(resolve).toHaveBeenCalledOnce();
    expect(() => createNativeModuleLoader(() => null)()).toThrow("not linked");
    expect(() => createNativeModuleLoader(() => module(2))()).toThrow(
      "does not match JavaScript version 1",
    );
  });

  test("decodes response buffers and exact integers", () => {
    const bytes = response('{"bytes":{"$buffer":0},"sequence":{"$integer":"9007199254740993"}}', [
      new Uint8Array([4, 5, 6]),
    ]);

    expect(decodeResponse(bytes)).toEqual({
      bytes: new Uint8Array([4, 5, 6]),
      sequence: 9_007_199_254_740_993n,
    });
    expect(() => decodeResponse(Uint8Array.from([...bytes, 0]))).toThrow("trailing bytes");
  });

  test("installs the Hermes Web Crypto subset from Expo Crypto", async () => {
    const target: { crypto?: Crypto } = {};
    installExpoCrypto(target, {
      digest: async (_algorithm, data) =>
        Uint8Array.from(new Uint8Array(data as ArrayBuffer), (byte) => byte ^ 0xff).buffer,
      getRandomValues: <T extends ArrayBufferView>(value: T): T => {
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength).fill(7);
        return value;
      },
      randomUUID: () => "00000000-0000-4000-8000-000000000000",
    });

    const random = new Uint8Array(3);
    expect(target.crypto?.getRandomValues(random)).toBe(random);
    expect(random).toEqual(new Uint8Array([7, 7, 7]));
    expect(target.crypto?.randomUUID()).toBe("00000000-0000-4000-8000-000000000000");
    await expect(
      target.crypto?.subtle.digest("SHA-256", new Uint8Array([0, 255])),
    ).resolves.toEqual(new Uint8Array([255, 0]).buffer);
  });

  test("adds missing crypto methods without replacing an existing provider", async () => {
    const encrypt = vi.fn();
    const existing = {
      getRandomValues: <T extends ArrayBufferView>(value: T): T => value,
      subtle: { encrypt },
    } as unknown as Crypto;
    const target = { crypto: existing };
    installExpoCrypto(target, {
      digest: async () => new ArrayBuffer(32),
      getRandomValues: <T extends Uint8Array>(value: T): T => value,
      randomUUID: () => "00000000-0000-4000-8000-000000000000",
    });

    expect(target.crypto).toBe(existing);
    expect((target.crypto.subtle as unknown as { encrypt: unknown }).encrypt).toBe(encrypt);
    expect(target.crypto.randomUUID()).toBe("00000000-0000-4000-8000-000000000000");
    await expect(target.crypto.subtle.digest("SHA-256", new Uint8Array())).resolves.toHaveProperty(
      "byteLength",
      32,
    );
  });
});

function module(version: number): NativeModule {
  return {
    apiVersion: () => version,
    open: vi.fn(),
  };
}

function response(json: string, buffers: Uint8Array[]): Uint8Array {
  const bytes: number[] = [0x85];
  string(bytes, "ok");
  bytes.push(0xc3);
  string(bytes, "json");
  string(bytes, json);
  string(bytes, "buffers");
  bytes.push(0x90 | buffers.length);
  for (const buffer of buffers) {
    bytes.push(0xc4, buffer.length, ...buffer);
  }
  string(bytes, "error");
  bytes.push(0xc0);
  string(bytes, "version");
  bytes.push(1);
  return Uint8Array.from(bytes);
}

function string(output: number[], value: string): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length < 32) output.push(0xa0 | bytes.length);
  else output.push(0xd9, bytes.length);
  output.push(...bytes);
}
