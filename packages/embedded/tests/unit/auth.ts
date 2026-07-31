import type { UserIdentity } from "convex/server";
import { makeFunctionReference } from "convex/server";
import { describe, expect, test } from "vite-plus/test";

import { createEmbeddedAuthState, EmbeddedClient } from "../../src/client";
import {
  EMBEDDED_PROTOCOL_VERSION,
  EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY,
} from "../../src/protocol";
import type { Runner, RunOptions } from "../../src/runtime/runner";

const read = makeFunctionReference<"query", Record<string, never>, string>("auth:read");

describe("embedded auth partitions", () => {
  test("offline reopen hydrates the cached accepted identity before local execution", async () => {
    const accepted = identity("cached");
    let observedAuth: UserIdentity | null | undefined;
    const runner = fakeRunner({
      cachedRead: async () => ({ identity: accepted, identityKey: "cached-key" }),
      runQuery: (options) => {
        observedAuth = options.auth;
        return "ready";
      },
    });
    const client = new EmbeddedClient({ runner });

    await expect(client.query(read, {})).resolves.toBe("ready");
    expect(observedAuth).toEqual(accepted);
    await client.close();
  });

  test("clearAuth switches storage before unauthenticated local execution", async () => {
    const switched = deferred<void>();
    const writes: string[] = [];
    const auth = createEmbeddedAuthState();
    auth.identity = identity("old");
    let observedAuth: UserIdentity | null | undefined;
    const runner = fakeRunner({
      runQuery: (options) => {
        observedAuth = options.auth;
        return "ready";
      },
      write: async (identityKey) => {
        writes.push(identityKey);
        await switched.promise;
      },
    });
    const client = new EmbeddedClient({ authState: auth, runner });

    client.clearAuth();
    const result = client.query(read, {});
    await Promise.resolve();
    expect(observedAuth).toBeUndefined();

    switched.resolve(undefined);
    await expect(result).resolves.toBe("ready");
    expect(writes).toEqual([EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY]);
    expect(observedAuth).toBeNull();
    await client.close();
  });

  test("failed identity refresh retains the last server-accepted identity", async () => {
    const accepted = identity("accepted");
    const auth = createEmbeddedAuthState();
    auth.identity = accepted;
    let observedAuth: UserIdentity | null | undefined;
    const runner = fakeRunner({
      remoteRead: async () => {
        throw new Error("offline");
      },
      runQuery: (options) => {
        observedAuth = options.auth;
        return "ready";
      },
    });
    const client = new EmbeddedClient({ authState: auth, runner });

    client.setAuth(async () => "token");
    await expect(client.query(read, {})).resolves.toBe("ready");
    expect(observedAuth).toEqual(accepted);
    await client.close();
  });

  test("accepted refresh changes auth only after the runtime changes partitions", async () => {
    const accepted = identity("next");
    const order: string[] = [];
    let observedAuth: UserIdentity | null | undefined;
    const runner = fakeRunner({
      remoteRead: async () => {
        order.push("partition");
        return {
          identity: accepted,
          identityKey: "next-key",
          protocolVersion: EMBEDDED_PROTOCOL_VERSION,
        };
      },
      runQuery: (options) => {
        order.push("query");
        observedAuth = options.auth;
        return "ready";
      },
    });
    const client = new EmbeddedClient({ runner });
    const changed = deferred<void>();

    client.setAuth(
      async () => "token",
      (authenticated) => {
        if (authenticated) changed.resolve(undefined);
      },
    );
    await changed.promise;
    await expect(client.query(read, {})).resolves.toBe("ready");
    expect(order).toEqual(["partition", "query"]);
    expect(observedAuth).toEqual(accepted);
    await client.close();
  });

  test("unauthenticated identity key equals crates/remote/src/config.rs", () => {
    expect(EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY).toBe("unauthenticated");
  });
});

function fakeRunner(options: {
  cachedRead?: Runner["identity"]["read"];
  remoteRead?: NonNullable<Runner["remote"]>["identity"]["read"];
  runQuery?: (options: RunOptions) => unknown;
  write?: Runner["identity"]["write"];
}): Runner {
  return {
    identity: {
      read: options.cachedRead ?? (async () => undefined),
      write: options.write ?? (async () => undefined),
    },
    localConfigured: false,
    route: async () => ({ execution: "local", placement: "replicated" }),
    runQuery: async (_ref, _args, runOptions = {}) => options.runQuery?.(runOptions),
    runMutation: async () => undefined,
    runAction: async () => undefined,
    handleUpload: async () => ({ storageId: "unused" }),
    devtools: async () => undefined,
    invalidate: () => undefined,
    rerunResults: () => undefined,
    remote: {
      identity: { read: options.remoteRead ?? (async () => undefined) },
      scope: { write: async () => undefined },
    },
    onUpdate: () => () => undefined,
  };
}

function identity(subject: string): UserIdentity {
  return {
    issuer: "https://issuer.example",
    subject,
    tokenIdentifier: `issuer|${subject}`,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
