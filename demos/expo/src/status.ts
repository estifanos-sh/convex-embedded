import type { EmbeddedConnectionState } from "@convex-dev/embedded/expo";

import type { EditorSaveState } from "./types";

export type DocumentStatusState = EditorSaveState | "opening";
export type DocumentStatusTone = "error" | "idle" | "progress" | "success" | "warning";

export type DocumentStatus = {
  accessibilityLabel: string;
  emphasized: boolean;
  label: string;
  tone: DocumentStatusTone;
};

/** Keep local durability and deployment replication distinct in the editor header. */
export function documentStatus(
  state: DocumentStatusState,
  connection: EmbeddedConnectionState,
): DocumentStatus {
  if (state === "dirty") return status("Unsaved", "warning", true);
  if (state === "error") return status("Retry", "error", true);
  if (state === "opening") return status("Opening", "idle", false);
  if (state === "recovered") return status("Recovered", "warning", true);
  if (state === "saving") return status("Saving", "progress", true);

  if (connection.remote === "ready") return status("Synced", "success", false);
  if (connection.remote === "connected") return status("Syncing", "progress", true);
  if (connection.remote === "starting") return status("Connecting", "progress", true);
  if (connection.remote === "offline" || connection.remote === "closed") {
    return status("Saved offline", "warning", true);
  }
  if (connection.remote === "error") {
    return {
      ...status("Sync error", "error", true),
      accessibilityLabel: `Sync error: ${connection.remoteError}`,
    };
  }
  return status("Saved", "success", false);
}

function status(label: string, tone: DocumentStatusTone, emphasized: boolean): DocumentStatus {
  return { accessibilityLabel: label, emphasized, label, tone };
}
