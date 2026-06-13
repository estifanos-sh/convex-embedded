import { embeddedIdentity } from "virtual:convex-embedded/identity";
import { setEmbeddedIdentity } from "./identity";
import { createConvexEmbeddedCoordinatedWorkerFromMessage } from "./coordinator";

setEmbeddedIdentity(embeddedIdentity);
createConvexEmbeddedCoordinatedWorkerFromMessage();
