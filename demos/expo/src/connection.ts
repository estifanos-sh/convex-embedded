import type { EmbeddedConnectionState } from "@convex-dev/embedded/expo";
import { useEffect, useState } from "react";

import { client } from "./client";

/** Observe local startup and native remote replication without polling the network. */
export function useEmbeddedConnectionState(): EmbeddedConnectionState {
  const [state, setState] = useState<EmbeddedConnectionState>(() => client.connectionState());

  useEffect(() => {
    const read = (): void => setState(client.connectionState());
    const unsubscribe = client.subscribeEvents((event) => {
      if (event.type === "remote" || event.type === "runtime") read();
    });
    read();
    return unsubscribe;
  }, []);

  return state;
}
