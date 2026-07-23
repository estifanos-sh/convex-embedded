import { describe, expect, test } from "vite-plus/test";

import {
  StaleTextBaseError,
  assertTextBase,
  isSpliceRangeError,
  isStaleTextBaseError,
} from "../../src/crdt/intent";
import { base, diff } from "../../src/text";
import { createTextField } from "../../src/text/field";

type Splice = { index: number; delete: number; insert: string };

function applySplice(before: string, splice: Splice): string {
  return before.slice(0, splice.index) + splice.insert + before.slice(splice.index + splice.delete);
}

describe("text.diff", () => {
  test("returns undefined for equal strings", () => {
    expect(diff("", "")).toBeUndefined();
    expect(diff("hello", "hello")).toBeUndefined();
    expect(diff("a🙂b", "a🙂b")).toBeUndefined();
  });

  test("round-trips prefix, suffix, middle, insert, and delete edits", () => {
    const cases: Array<[string, string]> = [
      ["hello", "hello world"],
      ["hello world", "hello"],
      ["hello", "jello"],
      ["hello", "helloo"],
      ["abcde", "axcye"],
      ["", "seeded"],
      ["seeded", ""],
      ["同じ接頭辞", "同じ接尾辞"],
    ];
    for (const [before, after] of cases) {
      const splice = diff(before, after);
      expect(splice, `${before} -> ${after}`).toBeDefined();
      expect(applySplice(before, splice as Splice)).toBe(after);
    }
  });

  test("reports UTF-16 units across astral characters", () => {
    expect(diff("a🙂b", "a🙂c")).toEqual({ index: 3, delete: 1, insert: "c" });
    expect(diff("ab", "a🙂b")).toEqual({ index: 1, delete: 0, insert: "🙂" });
    expect(applySplice("a🙂b", diff("a🙂b", "a🙂c") as Splice)).toBe("a🙂c");
    expect(applySplice("ab", diff("ab", "a🙂b") as Splice)).toBe("a🙂b");
  });
});

describe("text.base", () => {
  test("is a stable lowercase 64-hex SHA-256 digest", async () => {
    const first = await base("hello");
    const second = await base("hello");
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  test("distinguishes values that differ only by a trailing space", async () => {
    expect(await base("hello")).not.toBe(await base("hello "));
    expect(await base("")).not.toBe(await base("hello"));
  });
});

describe("assertTextBase", () => {
  test("passes when the fingerprint matches the source", async () => {
    await expect(
      assertTextBase("docs", "body", "hello", await base("hello")),
    ).resolves.toBeUndefined();
  });

  test("throws a StaleTextBaseError when the fingerprint is stale", async () => {
    let thrown: unknown;
    try {
      await assertTextBase("docs", "body", "hello", await base("goodbye"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StaleTextBaseError);
    expect((thrown as Error).message).toContain(
      "docs.body changed since this edit was computed; rebase and retry",
    );
    expect(isStaleTextBaseError(thrown)).toBe(true);
  });

  test("is a no-op when base is undefined", async () => {
    await expect(assertTextBase("docs", "body", "hello", undefined)).resolves.toBeUndefined();
  });

  test("predicates reject unrelated errors", () => {
    expect(isStaleTextBaseError(new Error("nope"))).toBe(false);
    expect(isStaleTextBaseError({ name: "ConvexEmbeddedStaleTextBaseError" })).toBe(true);
    expect(
      isSpliceRangeError(new Error("text.splice: change range is outside the current value")),
    ).toBe(true);
    expect(isSpliceRangeError(new StaleTextBaseError("x"))).toBe(false);
  });
});

function casStore(initial: string) {
  const stale = "text.splice: docs.body changed since this edit was computed; rebase and retry";
  const store = {
    value: initial,
    firstAttemptExternal: undefined as string | undefined,
    read: (): string => store.value,
    write: async (splice: Splice, providedBase: string): Promise<string> => {
      if (store.firstAttemptExternal !== undefined) {
        store.value = store.firstAttemptExternal;
        store.firstAttemptExternal = undefined;
        throw new StaleTextBaseError(stale);
      }
      if (providedBase !== (await base(store.value))) {
        throw new StaleTextBaseError(stale);
      }
      store.value = applySplice(store.value, splice);
      return store.value;
    },
  };
  return store;
}

describe("createTextField", () => {
  test("a clean write adopts the returned body", async () => {
    const store = casStore("hello");
    const field = createTextField<string>({
      read: store.read,
      write: store.write,
      extract: (result) => result,
      delayMs: 1,
      maxLatencyMs: 4,
    });
    field.queue("hello world");
    field.flush();
    await field.settle();
    expect(store.value).toBe("hello world");
    expect(field.isDirty).toBe(false);
    expect(field.isSettling).toBe(false);
    field.close();
  });

  test("a stale-base rejection rebases once and converges without dropping the edit", async () => {
    const store = casStore("hello");
    store.firstAttemptExternal = "hello there";
    const field = createTextField<string>({
      read: store.read,
      write: store.write,
      extract: (result) => result,
      delayMs: 1,
      maxLatencyMs: 4,
    });
    field.queue("hello world");
    field.flush();
    await field.settle();
    expect(store.value).toBe("hello world");
    expect(field.isDirty).toBe(false);
    field.close();
  });

  test("adopt resets the baseline to an external value", async () => {
    const store = casStore("hello");
    const field = createTextField<string>({
      read: store.read,
      write: store.write,
      extract: (result) => result,
      delayMs: 1,
      maxLatencyMs: 4,
    });
    field.queue("hello world");
    field.flush();
    await field.settle();

    store.value = "external";
    field.adopt("external");
    expect(field.isDirty).toBe(false);
    expect(field.isSettling).toBe(false);

    field.queue("external!");
    field.flush();
    await field.settle();
    expect(store.value).toBe("external!");
    field.close();
  });

  test("adopt during a pending edit rebases it onto the new base without loss", async () => {
    const store = casStore("hello");
    const field = createTextField<string>({
      read: store.read,
      write: store.write,
      extract: (result) => result,
      delayMs: 40,
      maxLatencyMs: 160,
    });
    field.queue("hello world");
    expect(field.isDirty).toBe(true);

    store.value = "hello there";
    field.adopt("hello there");
    field.flush();
    await field.settle();
    expect(store.value).toBe("hello world");
    expect(field.isDirty).toBe(false);
    field.close();
  });

  test("a lagging read retries until the snapshot freshens, then converges", async () => {
    const staleMessage =
      "text.splice: docs.body changed since this edit was computed; rebase and retry";
    let lagging = true;
    const store = { value: "hello", writes: 0 };
    const field = createTextField<string>({
      read: () => (lagging ? "hello" : store.value),
      write: async (splice, providedBase) => {
        store.writes += 1;
        if (providedBase !== (await base(store.value))) throw new StaleTextBaseError(staleMessage);
        store.value = applySplice(store.value, splice);
        return store.value;
      },
      extract: (result) => result,
      delayMs: 1,
      maxLatencyMs: 4,
    });

    store.value = "hello there";
    field.queue("hello world");
    field.flush();

    const outcome = { state: "pending" as "pending" | "resolved" | "rejected" };
    const settled = field.settle().then(
      () => {
        outcome.state = "resolved";
      },
      () => {
        outcome.state = "rejected";
      },
    );

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(store.writes).toBeGreaterThanOrEqual(2);
    expect(outcome.state).toBe("pending");
    expect(field.isSettling).toBe(true);
    expect(field.isDirty).toBe(true);

    lagging = false;
    field.adopt("hello there");
    await settled;

    expect(store.value).toBe("hello world");
    expect(outcome.state).toBe("resolved");
    expect(field.isDirty).toBe(false);
    expect(field.isSettling).toBe(false);
    field.close();
  });
});
