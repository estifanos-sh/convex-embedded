// Keep this paired with the mobile Rust wire: required terminal settlements are not compatible
// with an artifact that serializes the older tick shape.
const VERSION = 10;
const BUFFER = "$buffer";
const FLOAT = "$float";
const INTEGER = "$integer";
const FLOAT_VIEW = new DataView(new ArrayBuffer(8));

export interface NativeEnvelope {
  buffers: Uint8Array[];
  json: string;
  operation: string;
  version: number;
}

interface NativeError {
  code: string;
  message: string;
}

interface NativeResponse {
  buffers: Uint8Array[];
  error?: NativeError | null;
  json: string;
  ok: boolean;
  version: number;
}

/** Encode one versioned request for the mobile Rust binding. @internal */
export function encodeRequest(operation: string, value?: unknown): Uint8Array {
  const buffers: Uint8Array[] = [];
  const json = JSON.stringify(split(value, buffers)) ?? "null";
  return encodeMessage({ buffers, json, operation, version: VERSION });
}

/** Decode a request envelope for protocol conformance tests. @internal */
export function decodeRequest(bytes: Uint8Array): NativeEnvelope {
  const request = decodeMessage(bytes) as NativeEnvelope;
  if (
    !request ||
    typeof request !== "object" ||
    typeof request.version !== "number" ||
    typeof request.operation !== "string" ||
    typeof request.json !== "string" ||
    !Array.isArray(request.buffers)
  ) {
    throw new Error("Convex Embedded native binding received an invalid request envelope.");
  }
  return request;
}

/** Decode one response from the mobile Rust binding. @internal */
export function decodeResponse<T>(bytes: Uint8Array): T {
  const response = decodeMessage(bytes) as NativeResponse;
  if (
    !response ||
    typeof response !== "object" ||
    response.version !== VERSION ||
    typeof response.ok !== "boolean" ||
    typeof response.json !== "string" ||
    !Array.isArray(response.buffers)
  ) {
    throw new Error("Convex Embedded native binding returned an invalid response envelope.");
  }
  if (!response.ok) {
    const code = response.error?.code ?? "native";
    const message = response.error?.message ?? "Native operation failed.";
    throw new Error(`[convex-embedded:${code}] ${message}`);
  }
  const parsed = JSON.parse(response.json) as unknown;
  return join(parsed, response.buffers) as T;
}

function split(value: unknown, buffers: Uint8Array[]): unknown {
  if (value instanceof Uint8Array) {
    const index = buffers.length;
    buffers.push(value);
    return { [BUFFER]: index };
  }
  if (typeof value === "bigint") return { [INTEGER]: value.toString() };
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
    FLOAT_VIEW.setFloat64(0, value, false);
    return { [FLOAT]: FLOAT_VIEW.getBigUint64(0, false).toString(16).padStart(16, "0") };
  }
  if (Array.isArray(value)) return value.map((child) => split(child, buffers));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, split(child, buffers)]),
    );
  }
  return value;
}

function join(value: unknown, buffers: Uint8Array[]): unknown {
  if (Array.isArray(value)) return value.map((child) => join(child, buffers));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length === 1 && typeof record[BUFFER] === "number") {
      const bytes = buffers[record[BUFFER]];
      if (!bytes) throw new Error("Convex Embedded native response referenced a missing buffer.");
      return bytes;
    }
    if (Object.keys(record).length === 1 && typeof record[INTEGER] === "string") {
      return BigInt(record[INTEGER]);
    }
    if (Object.keys(record).length === 1 && typeof record[FLOAT] === "string") {
      const bits = record[FLOAT];
      if (!/^[0-9a-f]{16}$/i.test(bits)) {
        throw new Error("Convex Embedded native response returned an invalid float marker.");
      }
      FLOAT_VIEW.setBigUint64(0, BigInt(`0x${bits}`), false);
      return FLOAT_VIEW.getFloat64(0, false);
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, child]) => [key, join(child, buffers)]),
    );
  }
  return value;
}

function encodeMessage(value: NativeEnvelope): Uint8Array {
  const writer = new MessageWriter();
  writer.map(4);
  writer.string("version");
  writer.integer(value.version);
  writer.string("operation");
  writer.string(value.operation);
  writer.string("json");
  writer.string(value.json);
  writer.string("buffers");
  writer.array(value.buffers.length);
  for (const bytes of value.buffers) writer.binary(bytes);
  return writer.finish();
}

function decodeMessage(bytes: Uint8Array): unknown {
  const reader = new MessageReader(bytes);
  const value = reader.read();
  reader.finish();
  return value;
}

class MessageWriter {
  private readonly chunks: Uint8Array[] = [];
  private size = 0;

  map(length: number): void {
    if (length < 16) this.byte(0x80 | length);
    else this.length(0xde, length, 2);
  }

  array(length: number): void {
    if (length < 16) this.byte(0x90 | length);
    else this.length(0xdc, length, 2);
  }

  integer(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new Error("MessagePack envelope integer is outside u32 range.");
    }
    if (value < 0x80) this.byte(value);
    else if (value <= 0xff) this.length(0xcc, value, 1);
    else if (value <= 0xffff) this.length(0xcd, value, 2);
    else this.length(0xce, value, 4);
  }

  string(value: string): void {
    const bytes = new TextEncoder().encode(value);
    if (bytes.length < 32) this.byte(0xa0 | bytes.length);
    else if (bytes.length <= 0xff) this.length(0xd9, bytes.length, 1);
    else if (bytes.length <= 0xffff) this.length(0xda, bytes.length, 2);
    else this.length(0xdb, bytes.length, 4);
    this.push(bytes);
  }

  binary(value: Uint8Array): void {
    if (value.length <= 0xff) this.length(0xc4, value.length, 1);
    else if (value.length <= 0xffff) this.length(0xc5, value.length, 2);
    else this.length(0xc6, value.length, 4);
    this.push(value);
  }

  finish(): Uint8Array {
    const result = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  private length(prefix: number, value: number, width: number): void {
    const bytes = new Uint8Array(width + 1);
    bytes[0] = prefix;
    for (let shift = (width - 1) * 8; shift >= 0; shift -= 8) {
      bytes[width - shift / 8] = (value >>> shift) & 0xff;
    }
    this.push(bytes);
  }

  private byte(value: number): void {
    this.push(Uint8Array.of(value));
  }

  private push(value: Uint8Array): void {
    this.chunks.push(value);
    this.size += value.length;
  }
}

class MessageReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  read(): unknown {
    const prefix = this.byte();
    if (prefix <= 0x7f) return prefix;
    if ((prefix & 0xe0) === 0xa0) return this.string(prefix & 0x1f);
    if ((prefix & 0xf0) === 0x80) return this.map(prefix & 0x0f);
    if ((prefix & 0xf0) === 0x90) return this.array(prefix & 0x0f);
    if (prefix >= 0xe0) return prefix - 0x100;
    switch (prefix) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xc4:
        return this.binary(this.uint(1));
      case 0xc5:
        return this.binary(this.uint(2));
      case 0xc6:
        return this.binary(this.uint(4));
      case 0xcc:
        return this.uint(1);
      case 0xcd:
        return this.uint(2);
      case 0xce:
        return this.uint(4);
      case 0xd9:
        return this.string(this.uint(1));
      case 0xda:
        return this.string(this.uint(2));
      case 0xdb:
        return this.string(this.uint(4));
      case 0xdc:
        return this.array(this.uint(2));
      case 0xdd:
        return this.array(this.uint(4));
      case 0xde:
        return this.map(this.uint(2));
      case 0xdf:
        return this.map(this.uint(4));
      default:
        throw new Error(`Unsupported MessagePack prefix 0x${prefix.toString(16)}.`);
    }
  }

  finish(): void {
    if (this.offset !== this.bytes.length) {
      throw new Error("MessagePack response has trailing bytes.");
    }
  }

  private map(length: number): Record<string, unknown> {
    const value: Record<string, unknown> = {};
    for (let index = 0; index < length; index += 1) {
      const key = this.read();
      if (typeof key !== "string") throw new Error("MessagePack response map key is not text.");
      value[key] = this.read();
    }
    return value;
  }

  private array(length: number): unknown[] {
    return Array.from({ length }, () => this.read());
  }

  private string(length: number): string {
    return new TextDecoder().decode(this.binary(length));
  }

  private binary(length: number): Uint8Array {
    const end = this.offset + length;
    if (end > this.bytes.length) throw new Error("Truncated MessagePack response.");
    const value = this.bytes.subarray(this.offset, end);
    this.offset = end;
    return value;
  }

  private uint(width: number): number {
    let value = 0;
    for (let index = 0; index < width; index += 1) value = value * 0x100 + this.byte();
    return value;
  }

  private byte(): number {
    const value = this.bytes[this.offset];
    if (value === undefined) throw new Error("Truncated MessagePack response.");
    this.offset += 1;
    return value;
  }
}
