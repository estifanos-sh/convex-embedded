import type { StoreSetupCandidate } from "./migrations";
import type { ConvexEmbeddedSchema } from "./schema";
import type { StorageBackend, StoreSchema } from "./storage/types";
import { setupWorkspaceSchema } from "./storage/workspace";

/** Private candidate controls implemented by every production storage adapter. */
export interface CandidateSurface {
  prepare(schema: StoreSchema): Promise<StoreSetupCandidate>;
  copy(generation: number): Promise<CandidateStep>;
  bind(schema: StoreSchema, generation: number): Promise<void>;
  materialize(generation: number): Promise<CandidateStep>;
  complete(generation: number): Promise<void>;
  policy(schema: StoreSchema, generation: number): Promise<CandidateStep>;
  retire(generation: number): Promise<CandidateStep>;
  validate(schema: StoreSchema, generation: number): Promise<void>;
  unbind(): Promise<void>;
  finalizePrepare(schema: StoreSchema, generation: number): Promise<void>;
  finalize(schema: StoreSchema, generation: number): Promise<void>;
}

export interface CandidateStep {
  /** True only after the phase completion marker has committed. */
  readonly done: boolean;
  /** Semantic records committed by this step. */
  readonly records: number;
}

export interface CandidateSetup<R> {
  readonly localSchemas: readonly ConvexEmbeddedSchema[];
  run(runner: R): Promise<void>;
}

export interface CandidateDependencies<R> {
  /** Private release-test seam invoked only after a phase has durably advanced. */
  checkpoint?: (phase: CandidatePhase) => Promise<void>;
  /** Construct a runner against the generation currently selected by storage. */
  createRunner(schema: StoreSchema, remote: boolean): R;
  /** Wait until local function modules are usable before setup or publication completes. */
  localReady(runner: R): Promise<unknown>;
  /** Runtime schema used after the exact target contract is published. */
  runnerSchema: StoreSchema;
  /** Optional app-authored compatibility phase. */
  setup?: CandidateSetup<R>;
  /** Store-contract schema, including the setup graph identity. */
  targetSchema: StoreSchema;
  /** Called while bounded copy/materialization work is making progress. */
  progress?: () => void;
  /** Final runner may use the remote lane; setup never can. */
  remote: boolean;
}

export type CandidatePhase =
  | "copy"
  | "cutover"
  | "finalizePrepare"
  | "materialize"
  | "policy"
  | "prepare"
  | "retire"
  | "setup"
  | "validate";

export interface CandidateOpenReport {
  readonly activeGeneration?: number;
  readonly candidateGeneration?: number;
  readonly required: boolean;
  readonly resumed: boolean;
  readonly retiredGenerations: readonly number[];
}

export interface CandidateOpenResult<R> {
  readonly report: CandidateOpenReport;
  readonly runner: R;
}

/**
 * Run the one private production startup protocol shared by direct Node/Expo and browser workers.
 * The caller owns store/runner closure on failure and shutdown.
 */
export async function openCandidate<R>(
  store: StorageBackend,
  dependencies: CandidateDependencies<R>,
): Promise<CandidateOpenResult<R>> {
  const candidate = candidateSurface(store);
  if (dependencies.setup !== undefined && candidate === undefined) {
    throw new Error("This storage backend does not support candidate-bound setup.");
  }
  if (candidate === undefined) {
    await store.setup(dependencies.targetSchema);
    const runner = dependencies.createRunner(dependencies.runnerSchema, dependencies.remote);
    await dependencies.localReady(runner);
    return { report: { required: false, resumed: false, retiredGenerations: [] }, runner };
  }

  let bound = false;
  let prepared: StoreSetupCandidate | undefined;
  const retired = new Set<number>();
  try {
    for (;;) {
      prepared = await candidate.prepare(dependencies.targetSchema);
      dependencies.progress?.();
      await dependencies.checkpoint?.("prepare");
      if (prepared.cleanupGeneration === undefined) break;
      const cleanupGeneration = prepared.cleanupGeneration;
      await advance(
        () => candidate.retire(cleanupGeneration),
        "retire",
        dependencies.progress,
        dependencies.checkpoint,
      );
    }
    for (const generation of prepared.retiredGenerations) retired.add(generation);
    if (prepared.required) {
      await advance(
        () => candidate.copy(prepared!.generation),
        "copy",
        dependencies.progress,
        dependencies.checkpoint,
      );
      await advance(
        () => candidate.policy(dependencies.targetSchema, prepared!.generation),
        "policy",
        dependencies.progress,
        dependencies.checkpoint,
      );
      if (!prepared.setupComplete) {
        if (dependencies.setup === undefined) {
          throw new Error(
            "The prepared store candidate requires its matching setup action; the active generation was preserved.",
          );
        }
        const workspace = setupWorkspaceSchema(
          prepared.sourceSchema,
          dependencies.targetSchema,
          dependencies.setup.localSchemas,
        );
        await candidate.bind(workspace, prepared.generation);
        bound = true;
        await advance(
          () => candidate.materialize(prepared!.generation),
          "materialize",
          dependencies.progress,
          dependencies.checkpoint,
        );
        const setupRunner = dependencies.createRunner(workspace, false);
        await dependencies.localReady(setupRunner);
        await dependencies.setup.run(setupRunner);
        await candidate.complete(prepared.generation);
        dependencies.progress?.();
        await dependencies.checkpoint?.("setup");
        await candidate.unbind();
        bound = false;
      }
      await candidate.finalizePrepare(dependencies.targetSchema, prepared.generation);
      dependencies.progress?.();
      await dependencies.checkpoint?.("finalizePrepare");
      await candidate.bind(dependencies.targetSchema, prepared.generation);
      bound = true;
      await advance(
        () => candidate.materialize(prepared!.generation),
        "materialize",
        dependencies.progress,
        dependencies.checkpoint,
      );
      await candidate.validate(dependencies.targetSchema, prepared.generation);
      await dependencies.checkpoint?.("validate");
      await candidate.unbind();
      bound = false;
      await candidate.finalize(dependencies.targetSchema, prepared.generation);
      await dependencies.checkpoint?.("cutover");
      retired.add(prepared.activeGeneration);
    } else {
      await store.setup(dependencies.targetSchema);
    }
  } finally {
    if (bound) await candidate.unbind().catch(() => undefined);
  }

  const runner = dependencies.createRunner(dependencies.runnerSchema, dependencies.remote);
  await dependencies.localReady(runner);
  for (const generation of retired) {
    await advance(
      () => candidate.retire(generation),
      "retire",
      dependencies.progress,
      dependencies.checkpoint,
    ).catch(() => undefined);
  }
  return {
    report: {
      activeGeneration: prepared?.activeGeneration,
      candidateGeneration: prepared?.generation,
      required: prepared?.required ?? false,
      resumed: prepared?.resumed ?? false,
      retiredGenerations: [...retired],
    },
    runner,
  };
}

export function candidateSurface(store: StorageBackend): CandidateSurface | undefined {
  return (store as StorageBackend & { candidate?: CandidateSurface }).candidate;
}

async function advance(
  step: () => Promise<CandidateStep>,
  phase: CandidatePhase,
  progress: CandidateDependencies<unknown>["progress"],
  checkpoint: CandidateDependencies<unknown>["checkpoint"],
): Promise<void> {
  for (;;) {
    const result = await step();
    progress?.();
    await checkpoint?.(phase);
    if (result.done) return;
  }
}
