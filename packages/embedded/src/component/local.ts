import type { ModuleMap } from "../runtime/runner";

import { clear as crdtClear } from "./crdt";
import { write as checkpointWrite } from "./crdt/checkpoint";
import { get as fieldGet, read as fieldRead } from "./crdt/field";
import { delete as payloadDelete } from "./crdt/payload";
import { delete as fileDelete, read as fileRead } from "./file";
import { delete as mutationDelete, read as mutationRead } from "./mutation";
import {
  acknowledge,
  commit,
  pull,
  replayConsume,
  replayWrite,
  settlementRead,
  witnessRead,
} from "./protocol";
import { read as clientRead, retire as clientRetire } from "./remote/client";
import {
  ack,
  checkpointWrite as revisionCheckpointWrite,
  create,
  createLocal,
  createReplay,
  delete as revisionDelete,
  get,
  list,
  restoreRead,
  retain,
  retainLocal,
  set,
} from "./rev";

/** Package-owned component modules recognized by the local runtime. @internal */
export const embeddedComponentModules: ModuleMap = {
  crdt: { clear: crdtClear },
  "crdt/checkpoint": { write: checkpointWrite },
  "crdt/field": { get: fieldGet, read: fieldRead },
  "crdt/payload": { delete: payloadDelete },
  file: { delete: fileDelete, read: fileRead },
  mutation: { delete: mutationDelete, read: mutationRead },
  protocol: {
    acknowledge,
    commit,
    pull,
    replayConsume,
    replayWrite,
    settlementRead,
    witnessRead,
  },
  "remote/client": { read: clientRead, retire: clientRetire },
  rev: {
    ack,
    checkpointWrite: revisionCheckpointWrite,
    create,
    createLocal,
    createReplay,
    delete: revisionDelete,
    get,
    list,
    restoreRead,
    retain,
    retainLocal,
    set,
  },
};
