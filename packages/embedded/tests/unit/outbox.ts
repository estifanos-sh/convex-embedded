import { describe, expect, test } from "vite-plus/test";

import { RequestOutbox } from "../../src/browser/coordinator/outbox";
import {
  WorkerCommand,
  WorkerEvent,
  type WorkerRequest,
  type WorkerResponse,
} from "../../src/browser/protocol";

function outbox() {
  const responses: WorkerResponse[] = [];
  return {
    box: new RequestOutbox({
      clearTimer: (timer) => clearTimeout(timer),
      post: (response) => responses.push(response),
      setTimer: (callback, ms) => setTimeout(callback, ms),
    }),
    responses,
  };
}

describe("RequestOutbox", () => {
  test("records more than one thousand active watches", () => {
    const { box } = outbox();

    for (let index = 0; index < 1_100; index += 1) {
      box.record({
        args: { index },
        clientId: "client",
        id: index + 1,
        name: "messages:list",
        op: WorkerCommand.WatchStart,
        watchId: index + 1,
      });
    }

    expect(box.desiredWatches()).toHaveLength(1_100);
    expect(box.ownershipRequests()).toHaveLength(1_100);
  });

  test("records more than one thousand queued requests during owner changes", () => {
    const { box } = outbox();

    for (let index = 0; index < 1_100; index += 1) {
      box.record({
        args: { index },
        clientId: "client",
        id: index + 1,
        name: "messages:list",
        op: WorkerCommand.Query,
      });
    }

    expect(box.ownershipRequests()).toHaveLength(1_100);
    for (let index = 0; index < 1_100; index += 1) {
      box.complete({ id: index + 1, op: WorkerEvent.Result });
    }
    expect(box.ownershipRequests()).toEqual([]);
  });

  test("watch stops still cancel pending watch starts in an unbounded outbox", () => {
    const { box, responses } = outbox();
    const start = {
      args: {},
      clientId: "client",
      id: 1,
      name: "messages:list",
      op: WorkerCommand.WatchStart,
      watchId: 7,
    } satisfies WorkerRequest;

    box.record(start);
    box.record({ clientId: "client", id: 2, op: WorkerCommand.WatchStop, watchId: 7 });

    expect(box.desiredWatches()).toEqual([]);
    expect(box.ownershipRequests()).toHaveLength(1);
    expect(responses).toContainEqual({ id: 1, op: WorkerEvent.Result });
  });

  test("owns and clears a zero-valued browser timer handle", () => {
    const cleared: Array<ReturnType<typeof setTimeout>> = [];
    const box = new RequestOutbox({
      clearTimer: (timer) => cleared.push(timer),
      post: () => undefined,
      setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
    });
    box.record({
      args: {},
      clientId: "client",
      id: 1,
      name: "messages:list",
      op: WorkerCommand.Query,
    });

    box.armAckTimer(1, 10, () => undefined);
    box.confirm(1);

    expect(cleared).toEqual([0]);
  });

  test("does not replay a sent hosted action after ownership changes", () => {
    const { box, responses } = outbox();
    box.record({
      args: {},
      clientId: "client",
      id: 1,
      kind: "action",
      name: "email:send",
      op: WorkerCommand.Route,
    });
    box.markSent(1);

    expect(box.ownershipRequests()).toEqual([]);
    expect(responses).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({
          name: "ConvexEmbeddedOperationIndeterminateError",
        }),
        id: 1,
        op: WorkerEvent.Result,
      }),
    ]);
  });
});
