import { connect } from "@tursodatabase/database";
import type { Connection } from "../storage/types";

export async function openTurso(path: string): Promise<Connection> {
  // `custom_types` (enables the json type) isn't in the SDK's flag type, but the runtime honors it.
  const experimental = ["strict", "custom_types"] as unknown as "strict"[];
  const db = await connect(path, { experimental, timeout: 5_000 });
  await db.exec("PRAGMA journal_mode = WAL");
  await db.exec("PRAGMA synchronous = NORMAL");
  await db.exec("PRAGMA temp_store = MEMORY");
  return db;
}
