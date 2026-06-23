import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export function writeRevisionVolume(options: { out: string; rowId: string; rows: number }): void {
  mkdirSync(dirname(options.out), { recursive: true });
  const file = openSync(options.out, "w");
  try {
    const chunkSize = 10_000;
    for (let start = 0; start < options.rows; start += chunkSize) {
      const end = Math.min(options.rows, start + chunkSize);
      let chunk = "";
      for (let sequence = start; sequence < end; sequence += 1) {
        const createdAt = sequence + 1;
        const revId = revisionVolumeId(sequence);
        chunk += `${JSON.stringify({
          createdAt,
          deleted: true,
          groupId: volumeId(sequence, 0x67),
          key: `${String(createdAt).padStart(16, "0")}:${revId}`,
          origin: "delete",
          revId,
          rowId: options.rowId,
          status: "retained",
          table: "documents",
        })}\n`;
      }
      writeSync(file, chunk);
    }
  } finally {
    closeSync(file);
  }
}

export function revisionVolumeId(sequence: number): string {
  return volumeId(sequence, 0x51);
}

function volumeId(sequence: number, marker: number): string {
  const hex = `${marker.toString(16).padStart(2, "0")}${sequence.toString(16).padStart(30, "0")}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}
