import { embeddedIdentity } from "virtual:convex-embedded/identity";
import { setEmbeddedIdentity } from "./identity";
import { createConvexEmbeddedCoordinatedWorkerFromMessage } from "./coordinator";

(
  globalThis as typeof globalThis & { __CONVEX_EMBEDDED_WORKER_BUILD__?: string }
).__CONVEX_EMBEDDED_WORKER_BUILD__ = "isolation-20260701";

setEmbeddedIdentity(embeddedIdentity);
createConvexEmbeddedCoordinatedWorkerFromMessage();
