import type { QuarantinePage, QuarantineRecord } from "./types";

interface QuarantineBinding {
  originPageRead(
    generation: bigint | number,
    cursorJson: string | undefined,
    pageSize: number,
  ): Promise<string> | string;
}

interface OriginPage {
  records: Array<{
    flags: number;
    identityKey: string;
    kind: number;
    payload: string;
    recordKey: string;
  }>;
  cursor?: { identityKey: string; kind: number; recordKey: string };
}

/** Reads one bounded raw quarantine page after an explicit local inspection action. */
export async function readDeviceQuarantinePage(
  binding: QuarantineBinding,
  generation: number,
  options: { cursor?: string; pageSize?: number } = {},
): Promise<QuarantinePage> {
  const pageSize = options.pageSize ?? 128;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_024) {
    throw new Error("Quarantine pageSize must be between 1 and 1024");
  }
  const page = JSON.parse(
    await binding.originPageRead(generation, options.cursor, pageSize),
  ) as OriginPage;
  const records = page.records.flatMap((record): QuarantineRecord[] => {
    if (record.flags !== 1) return [];
    const disposition = JSON.parse(
      new TextDecoder().decode(base64ToBytes(record.payload)),
    ) as Record<string, unknown>;
    if (
      typeof disposition.priorPayload !== "string" ||
      typeof disposition.priorCodec !== "number" ||
      typeof disposition.migrationId !== "string" ||
      typeof disposition.reason !== "string"
    ) {
      throw new Error("Quarantined originated record has invalid audit metadata");
    }
    return [
      {
        codec: disposition.priorCodec,
        identityKey: record.identityKey,
        kind: record.kind,
        migrationId: disposition.migrationId,
        payload: base64ToBytes(disposition.priorPayload),
        reason: disposition.reason,
        recordKey: base64ToBytes(record.recordKey),
      },
    ];
  });
  return {
    records,
    ...(page.cursor === undefined ? {} : { cursor: JSON.stringify(page.cursor) }),
  };
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
}
