export function randomId(prefix: string): string {
  const crypto = (
    globalThis as {
      crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array; randomUUID?: () => string };
    }
  ).crypto;
  const uuid = crypto?.randomUUID?.();
  if (uuid) return `${prefix}:${uuid}`;
  const bytes = new Uint8Array(16);
  crypto?.getRandomValues?.(bytes);
  const random = bytes.some((byte) => byte !== 0)
    ? [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
    : `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${random}`;
}
