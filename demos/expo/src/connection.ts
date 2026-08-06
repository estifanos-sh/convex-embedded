import type { EmbeddedConnectionState } from "@convex-dev/embedded/expo";
import { useEffect, useState } from "react";

import { client, clientReady } from "./client";

/** Observe local startup and native remote replication without polling the network. */
export function useEmbeddedConnectionState(): EmbeddedConnectionState {
  const [state, setState] = useState<EmbeddedConnectionState>(() => client.connectionState());

  useEffect(() => {
    let active = true;
    const unsubscribe = client.subscribeToConnectionState(setState);
    void clientReady
      .catch(() => undefined)
      .then(() => {
        if (active) setState(client.connectionState());
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return state;
}
