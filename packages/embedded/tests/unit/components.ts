import { describe, expect, test } from "vite-plus/test";

import { namespaceBatch } from "../../src/runtime/components";
import type { ScheduledJob, WriteBatch } from "../../src/storage/types";

const schedule: ScheduledJob = {
  jobId: "job_1",
  kind: "mutation",
  name: "documents:notify",
  args: "{}",
  dueTime: 100,
  createdTime: 50,
  updatedTime: 50,
  state: "pending",
};

const batch: WriteBatch = {
  upserts: [{ table: "documents", id: "documents:1", data: {}, cols: {}, creationTime: 1 }],
  deletes: [],
  schedules: [schedule],
};

describe("namespaceBatch", () => {
  test("carries schedules through a namespaced instance while mapping row tables", () => {
    const namespaced = namespaceBatch("embedded", batch);
    expect(namespaced.upserts[0]!.table).toBe("__e_documents");
    expect(namespaced.schedules).toEqual([schedule]);
  });

  test("returns the batch unchanged for the root instance", () => {
    expect(namespaceBatch("", batch).schedules).toEqual([schedule]);
  });
});
