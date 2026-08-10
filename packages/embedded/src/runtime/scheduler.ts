import { EmbeddedUnsupportedError } from "../error";
import type { DiagnosticEventListener } from "../events";
import type { RuntimeStorageWriter, ScheduledJob } from "../storage/types";
import { getTimerTime } from "../time";
import { decode, encode, normalizeCopy } from "./codec";
import { assertNoPendingCommitTs } from "./pending";
import { createId } from "./doc";
import { emitSchedulerUpsert } from "./emit";
import type { FunctionReference } from "./functions";
import { fullStore, functionName, type RuntimeCalls, type ServiceStore } from "./service";

export interface SchedulerService {
  cancel(jobId: string): Promise<void>;
  runAfter(
    delayMs: number,
    ref: FunctionReference,
    args?: Record<string, unknown>,
  ): Promise<string>;
  runAt(
    timeMs: number | Date,
    ref: FunctionReference,
    args?: Record<string, unknown>,
  ): Promise<string>;
}

export interface SchedulerPump {
  wake(delayMs?: number): void;
}

type SchedulerTimer = ReturnType<typeof setTimeout> & { unref?(): void };

const MAX_SCHEDULER_TIMER_MS = 2_147_483_647;
const SCHEDULER_RETRY_MS = 1_000;

function scheduleArgs(args: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeCopy(args) as Record<string, unknown>;
  assertNoPendingCommitTs(normalized, "scheduled function arguments");
  return normalized;
}

export function createSchedulerService(
  store: RuntimeStorageWriter,
  emit: DiagnosticEventListener,
  calls: RuntimeCalls | undefined,
  remoteActionRuntime: boolean,
  wake: SchedulerPump["wake"] = () => undefined,
  pending?: Array<() => Promise<void>>,
  scheduled?: string[],
  pendingRows?: ScheduledJob[],
): SchedulerService {
  const service = fullStore(store);
  const insert = async (
    delayOrTime: number,
    ref: FunctionReference,
    args: Record<string, unknown> = {},
    absolute: boolean,
  ) => {
    const schedule = service.schedule;
    if (!schedule) {
      throw new Error("Convex embedded runtime storage backend does not support scheduler.");
    }
    if (!calls) {
      throw new Error("Convex embedded scheduler cannot run from this context.");
    }
    const now = getTimerTime();
    const kind = await calls.kind(ref);
    if (kind === "action" && !remoteActionRuntime) {
      throw new EmbeddedUnsupportedError(
        "Scheduled actions are unsupported without a remote action runtime.",
      );
    }
    const job: ScheduledJob = {
      jobId: createId("_scheduled_functions"),
      kind,
      name: functionName(ref),
      args: encode(scheduleArgs(args)),
      dueTime: absolute ? delayOrTime : now + delayOrTime,
      state: "pending",
      createdTime: now,
      updatedTime: now,
    };
    scheduled?.push(job.jobId);
    const apply = async () => {
      await schedule.write(job);
      emitSchedulerUpsert(emit, job);
      wake(Math.max(0, job.dueTime - getTimerTime()));
    };
    if (pending && pendingRows) {
      pendingRows.push(job);
      pending.push(async () => {
        emitSchedulerUpsert(emit, job);
        wake(Math.max(0, job.dueTime - getTimerTime()));
      });
    } else if (pending) {
      pending.push(apply);
    } else {
      await apply();
    }
    return job.jobId;
  };
  return {
    runAfter: (delayMs: number, ref: FunctionReference, args?: Record<string, unknown>) =>
      insert(delayMs, ref, args, false),
    runAt: (timeMs: number | Date, ref: FunctionReference, args?: Record<string, unknown>) =>
      insert(timeMs instanceof Date ? timeMs.getTime() : timeMs, ref, args, true),
    cancel: async (jobId: string) => {
      const schedule = service.schedule;
      if (!schedule) {
        throw new Error("Convex embedded runtime storage backend does not support scheduler.");
      }
      const apply = async () => {
        const job = await schedule.cancel(jobId, getTimerTime());
        if (job) emitSchedulerUpsert(emit, job);
        wake(0);
      };
      if (pending) pending.push(apply);
      else await apply();
    },
  };
}

export function createSchedulerPump(
  store: RuntimeStorageWriter,
  calls: RuntimeCalls,
  emit: DiagnosticEventListener,
): SchedulerPump {
  const service = fullStore(store);
  if (!service.schedule) return { wake: () => undefined };
  let running = false;
  let dirty = false;
  let timer: SchedulerTimer | undefined;
  let timerAt = Number.POSITIVE_INFINITY;

  const schedule = (delayMs: number): void => {
    const delay = clampSchedulerDelay(delayMs);
    const target = getTimerTime() + delay;
    if (timer !== undefined && timerAt <= target) return;
    if (timer !== undefined) clearTimeout(timer);
    timerAt = target;
    timer = setTimeout(() => {
      timer = undefined;
      timerAt = Number.POSITIVE_INFINITY;
      void pump();
    }, delay) as SchedulerTimer;
    timer.unref?.();
  };

  const pump = async (): Promise<void> => {
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    try {
      do {
        dirty = false;
        await runScheduledDue(store, calls, emit);
      } while (dirty);
      const nextDelay = await nextSchedulerDelay(service.schedule!);
      if (nextDelay !== undefined) schedule(nextDelay);
    } catch {
      schedule(SCHEDULER_RETRY_MS);
    } finally {
      running = false;
      if (dirty) schedule(0);
    }
  };

  return {
    wake(delayMs = 0): void {
      if (running) {
        dirty = true;
        return;
      }
      schedule(delayMs);
    },
  };
}

async function runScheduledDue(
  store: RuntimeStorageWriter,
  calls: RuntimeCalls,
  emit: DiagnosticEventListener,
): Promise<void> {
  const service = fullStore(store);
  if (!service.schedule) return;
  for (;;) {
    const job = await service.schedule.lease.write(getTimerTime());
    if (!job) break;
    emitSchedulerUpsert(emit, job);
    try {
      if (job.kind === "mutation") {
        await calls.runMutation(job.name, decode(job.args) as Record<string, unknown>);
      } else if (calls.runAction) {
        await calls.runAction(job.name, decode(job.args) as Record<string, unknown>);
      } else {
        throw new Error("scheduled action runner is unavailable");
      }
      const completed = await service.schedule.complete(job.jobId, getTimerTime());
      if (completed) emitSchedulerUpsert(emit, completed);
    } catch {
      const failed = await service.schedule.fail(job.jobId, getTimerTime());
      if (failed) emitSchedulerUpsert(emit, failed);
    }
  }
}

async function nextSchedulerDelay(
  schedule: NonNullable<ServiceStore["schedule"]>,
): Promise<number | undefined> {
  const now = getTimerTime();
  let nextAt = Number.POSITIVE_INFINITY;
  for (const job of await schedule.read()) {
    if (job.state === "pending") {
      nextAt = Math.min(nextAt, job.dueTime);
    } else if (job.state === "running") {
      nextAt = Math.min(nextAt, job.leaseUntil + 1);
    }
  }
  return nextAt === Number.POSITIVE_INFINITY ? undefined : Math.max(0, nextAt - now);
}

function clampSchedulerDelay(delayMs: number): number {
  if (!Number.isFinite(delayMs)) return MAX_SCHEDULER_TIMER_MS;
  return Math.max(0, Math.min(MAX_SCHEDULER_TIMER_MS, Math.ceil(delayMs)));
}
