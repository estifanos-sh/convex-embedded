/**
 * Browser-harness-only access to the diagnostics bridge.
 *
 * This module deliberately has no package export. Test bundles load its built artifact directly,
 * so production applications can reach diagnostics only through the public `/devtools` source.
 *
 * @internal
 */
import type { EmbeddedClient } from "../client";
import type { DiagnosticEventListener } from "../events";
import { readDevtoolsBridge } from "./bridge";

/** Subscribe to diagnostics from a test-owned browser harness. @internal */
export function subscribeToDevtoolsDiagnostics(
  client: EmbeddedClient,
  listener: DiagnosticEventListener,
): () => void {
  return readDevtoolsBridge(client).subscribe(listener);
}
