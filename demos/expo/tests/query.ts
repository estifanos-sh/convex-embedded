import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FunctionReference, FunctionReturnType } from "convex/server";
import type { Id } from "../../../convex/_generated/dataModel";
import * as React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { api } from "../../../convex/_generated/api";
import {
  type EmbeddedQueryClient,
  type EmbeddedQueryWatch,
  openQuerySubscription,
  queryIdentity,
  useQuerySubscription,
  waitForQuerySubscription,
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

  void it("waits through an initial local miss until a remote document is materialized", async () => {
    type Document = FunctionReturnType<typeof api.documents.get>;
    let callback: () => void = () => undefined;
    let value: Document | undefined = null;
    let stops = 0;
    const client: EmbeddedQueryClient = {
      watchQuery<Query extends FunctionReference<"query">>(): EmbeddedQueryWatch<
        FunctionReturnType<Query>
      > {
        return {
          localQueryResult: () => value as FunctionReturnType<Query> | undefined,
          onUpdate: (next) => {
            callback = next;
            return () => {
              stops += 1;
            };
          },
        };
      },
    };
    const id = "documents|remote" as Id<"documents">;
    let resolved = false;
    const result = waitForQuerySubscription(
      client,
      api.documents.get,
      { id },
      {
        accept: (document) => document !== null && document._id.startsWith("documents|"),
      },
    ).then((document) => {
      resolved = true;
      return document;
    });

    await Promise.resolve();
    assert.equal(resolved, false);
    value = {
      _creationTime: 1,
      _id: "hosted-remote" as Id<"documents">,
      body: "[]",
      slug: "remote",
      title: "Remote",
      updatedAt: 1,
    };
    callback();

    await Promise.resolve();
    assert.equal(resolved, false);
    value = { ...value, _id: id };
    callback();

    assert.equal((await result)?.title, "Remote");
    assert.equal(stops, 1);
  });

  void it("retains a materialized remote document until its owner closes", async () => {
    type Document = FunctionReturnType<typeof api.documents.get>;
    let callback: () => void = () => undefined;
    let value: Document | undefined = null;
    let stops = 0;
    const client: EmbeddedQueryClient = {
      watchQuery<Query extends FunctionReference<"query">>(): EmbeddedQueryWatch<
        FunctionReturnType<Query>
      > {
        return {
          localQueryResult: () => value as FunctionReturnType<Query> | undefined,
          onUpdate: (next) => {
            callback = next;
            return () => {
              stops += 1;
            };
          },
        };
      },
    };
    const id = "documents|remote" as Id<"documents">;
    const subscription = openQuerySubscription(
      client,
      api.documents.get,
      { id },
      { accept: (document) => document !== null && document._id.startsWith("documents|") },
    );

    value = {
      _creationTime: 1,
      _id: id,
      body: "[]",
      slug: "remote",
      title: "Remote",
      updatedAt: 1,
    };
    callback();

    assert.equal((await subscription.result)?.title, "Remote");
    assert.equal(stops, 0);
    subscription.close();
    subscription.close();
    assert.equal(stops, 1);
  });

  void it("delivers retained query changes after the first materialized value", async () => {
    type Document = FunctionReturnType<typeof api.documents.get>;
    let callback: () => void = () => undefined;
    let value: Document | undefined = null;
    const updates: Document[] = [];
    const client: EmbeddedQueryClient = {
      watchQuery<Query extends FunctionReference<"query">>(): EmbeddedQueryWatch<
        FunctionReturnType<Query>
      > {
        return {
          localQueryResult: () => value as FunctionReturnType<Query> | undefined,
          onUpdate: (next) => {
            callback = next;
            return () => undefined;
          },
        };
      },
    };
    const id = "documents|remote" as Id<"documents">;
    const subscription = openQuerySubscription(
      client,
      api.documents.get,
      { id },
      {
        accept: (document) => document !== null && document._id.startsWith("documents|"),
        onUpdate: (document) => updates.push(document),
      },
    );

    value = {
      _creationTime: 1,
      _id: id,
      body: "[]",
      slug: "remote",
      title: "First",
      updatedAt: 1,
    };
    callback();
    assert.equal((await subscription.result)?.title, "First");
    assert.equal(updates.length, 0);

    value = { ...value, body: '[{"type":"paragraph","content":"peer"}]', title: "Peer" };
    callback();
    assert.equal(updates.at(-1)?.title, "Peer");
    assert.equal(updates.at(-1)?.body, value.body);

    value = null;
    callback();
    assert.equal(updates.at(-1), null);
    subscription.close();
  });

  void it("cancels a pending remote materialization subscription", async () => {
    let stops = 0;
    const client: EmbeddedQueryClient = {
      watchQuery<Query extends FunctionReference<"query">>(): EmbeddedQueryWatch<
        FunctionReturnType<Query>
      > {
        return {
          localQueryResult: () => null as FunctionReturnType<Query>,
          onUpdate: () => () => {
            stops += 1;
          },
        };
      },
    };
    const abort = new AbortController();
    const result = waitForQuerySubscription(
      client,
      api.documents.get,
      { id: "documents|remote" as Id<"documents"> },
      { accept: (document) => document !== null, signal: abort.signal },
    );
    abort.abort();

    await assert.rejects(result, { name: "AbortError" });
    assert.equal(stops, 1);
  });
});
