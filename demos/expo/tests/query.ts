import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FunctionReference, FunctionReturnType } from "convex/server";
import * as React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { api } from "../../../convex/_generated/api";
import {
  type EmbeddedQueryClient,
  type EmbeddedQueryWatch,
  queryIdentity,
  useQuerySubscription,
} from "../src/subscription";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

void describe("embedded query subscriptions", () => {
  void it("uses Convex semantics instead of generated proxy identity", () => {
    const first = api.documents.summaries;
    const second = api.documents.summaries;

    assert.notEqual(first, second);
    assert.equal(queryIdentity(first, { limit: 40 }), queryIdentity(second, { limit: 40 }));
    assert.notEqual(queryIdentity(first, { limit: 40 }), queryIdentity(second, { limit: 20 }));
  });

  void it("keeps one watcher for equivalent renders and cleans up changes", async () => {
    let starts = 0;
    let stops = 0;
    const client: EmbeddedQueryClient = {
      watchQuery<Query extends FunctionReference<"query">>(): EmbeddedQueryWatch<
        FunctionReturnType<Query>
      > {
        starts += 1;
        return {
          localQueryResult: () => undefined,
          onUpdate: () => {
            let active = true;
            return () => {
              if (!active) return;
              active = false;
              stops += 1;
            };
          },
        };
      },
    };

    function Probe({ limit }: { limit: number }) {
      useQuerySubscription(client, api.documents.summaries, { limit });
      return null;
    }

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(Probe, { limit: 40 }));
    });
    assert.equal(starts, 1);
    assert.equal(stops, 0);

    await act(async () => {
      renderer.update(React.createElement(Probe, { limit: 40 }));
    });
    assert.equal(starts, 1);
    assert.equal(stops, 0);

    await act(async () => {
      renderer.update(React.createElement(Probe, { limit: 20 }));
    });
    assert.equal(starts, 2);
    assert.equal(stops, 1);

    await act(async () => {
      renderer.unmount();
    });
    assert.equal(stops, 2);
  });
});
