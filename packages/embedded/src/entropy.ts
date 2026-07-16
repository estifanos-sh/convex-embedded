export interface EntropyStream {
  random(): number;
  uuid(): string;
  fill<T extends ArrayBufferView>(view: T): T;
}

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

const INTEGER_VIEWS = new Set([
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "BigInt64Array",
  "BigUint64Array",
]);

function rejectFill(message: string, name: string): never {
  if (typeof DOMException === "function") throw new DOMException(message, name);
  const error = new Error(message);
  error.name = name;
  throw error;
}

/**
 * One seeded word stream feeds every source in call order, so a `Math.random`-only run keeps the
 * exact word sequence it always had while `randomUUID`/`getRandomValues` take whole words for bytes.
 */
export function seedEntropy(seed: string): EntropyStream {
  let state = 2_166_136_261;
  for (let index = 0; index < seed.length; index += 1) {
    state = Math.imul(state ^ seed.charCodeAt(index), 16_777_619);
  }
  const word = (): number => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  };
  const bytes = (length: number): Uint8Array => {
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index += 4) {
      const value = word();
      out[index] = value & 0xff;
      if (index + 1 < length) out[index + 1] = (value >>> 8) & 0xff;
      if (index + 2 < length) out[index + 2] = (value >>> 16) & 0xff;
      if (index + 3 < length) out[index + 3] = (value >>> 24) & 0xff;
    }
    return out;
  };
  const uuid = (): string => {
    const b = bytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    return `${HEX[b[0]]}${HEX[b[1]]}${HEX[b[2]]}${HEX[b[3]]}-${HEX[b[4]]}${HEX[b[5]]}-${HEX[b[6]]}${HEX[b[7]]}-${HEX[b[8]]}${HEX[b[9]]}-${HEX[b[10]]}${HEX[b[11]]}${HEX[b[12]]}${HEX[b[13]]}${HEX[b[14]]}${HEX[b[15]]}`;
  };
  const fill = <T extends ArrayBufferView>(view: T): T => {
    if (!INTEGER_VIEWS.has(view?.constructor?.name ?? "")) {
      rejectFill("The data argument must be an integer-type TypedArray", "TypeMismatchError");
    }
    if (view.byteLength > 65_536) {
      rejectFill("The requested length exceeds 65,536 bytes", "QuotaExceededError");
    }
    new Uint8Array(view.buffer, view.byteOffset, view.byteLength).set(bytes(view.byteLength));
    return view;
  };
  return { random: () => word() / 4_294_967_296, uuid, fill };
}

/** Shims the clock and entropy globals for one mutation run, identically local and on replay. */
export async function withEntropy<T>(
  mutationTime: number,
  seed: string,
  run: () => T | Promise<T>,
): Promise<T> {
  const stream = seedEntropy(seed);
  const realNow = Date.now;
  const realRandom = Math.random;
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  const realUuid = crypto ? crypto.randomUUID.bind(crypto) : undefined;
  const realFill = crypto ? crypto.getRandomValues.bind(crypto) : undefined;
  const ownUuid = crypto ? Object.hasOwn(crypto, "randomUUID") : false;
  const ownFill = crypto ? Object.hasOwn(crypto, "getRandomValues") : false;
  Date.now = () => mutationTime;
  Math.random = () => stream.random();
  if (crypto) {
    (crypto as { randomUUID: unknown }).randomUUID = () => stream.uuid();
    (crypto as { getRandomValues: unknown }).getRandomValues = (view: ArrayBufferView) =>
      stream.fill(view);
  }
  try {
    return await run();
  } finally {
    Date.now = realNow;
    Math.random = realRandom;
    if (crypto) {
      if (ownUuid) (crypto as { randomUUID: unknown }).randomUUID = realUuid;
      else delete (crypto as { randomUUID?: unknown }).randomUUID;
      if (ownFill) (crypto as { getRandomValues: unknown }).getRandomValues = realFill;
      else delete (crypto as { getRandomValues?: unknown }).getRandomValues;
    }
  }
}
