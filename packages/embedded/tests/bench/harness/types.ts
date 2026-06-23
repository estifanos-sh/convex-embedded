/**
 * The playwright provider's `BrowserCommandContext` augmentation, stated locally. pnpm resolves
 * two peer variants of the test runner in this workspace, so the augmentation can land on the
 * other variant's interface; commands cast to this shape instead of depending on it.
 */
export interface PlaywrightCommandContext {
  context: import("playwright").BrowserContext;
  page: import("playwright").Page;
}

export interface BrowserLatencyBenchOptions {
  iterations: number;
  latencyP90BudgetMs: number;
  out?: string;
  profile: "full" | "smoke";
  rowCounts: number[];
  tabs: Array<"one" | "two">;
  warmups: number;
}

export interface BrowserStartupBenchOptions {
  iterations: number;
  out?: string;
  warmups: number;
}

export interface BrowserRemoteBenchOptions {
  iterations: number;
  out?: string;
  remoteUrl: string;
  timeoutMs: number;
  warmups: number;
}

export interface BrowserRemoteNetworkEvidence {
  queryAdds: number;
  queryRemoves: number;
  received: number;
  sent: number;
}

export interface BrowserRemoteSocketTrace {
  armReceived(value: string, timeoutMs: number): Promise<number>;
  cursor(): number;
  evidenceSince(cursor: number): BrowserRemoteNetworkEvidence;
}

export interface BrowserRemoteTickEvidence {
  actorQueueDepth: number;
  actorQueueMs: number;
  durationMs: number;
  pullAttempted: number;
  pushAccepted: number;
  pushAttempted: number;
  received: number;
  resultWrites: number;
  rowsApplied: number;
  sent: number;
  storeJobs: number;
}

export interface BrowserRemoteEmbeddedSample {
  admission: BrowserRemoteAdmissionTiming;
  admissionMs: number;
  cacheServes: number;
  listTransitions: number;
  network: BrowserRemoteNetworkEvidence;
  observer: BrowserRemoteTickEvidence;
  peerApplyMs: number;
  queryDeliveryMs: number;
  peerMs: number;
  resultWrites: number;
  settlementMs: number;
  transitions: number;
  runtime: BrowserRemoteRuntimeTiming;
  writer: BrowserRemoteTickEvidence;
}

export interface BrowserRemoteDirectSample {
  consistencyMs: number;
  listTransitions: number;
  network: BrowserRemoteNetworkEvidence;
  peerApplyMs: number;
  queryDeliveryMs: number;
  peerMs: number;
  transitions: number;
}

export interface BrowserRemoteBenchSample {
  delta: {
    peerApplyMs: number;
    peerMs: number;
    queryDeliveryMs: number;
  };
  direct: BrowserRemoteDirectSample;
  embedded: BrowserRemoteEmbeddedSample;
  index: number;
  order: "direct-first" | "embedded-first";
}

export interface BrowserRemoteAdmissionTiming {
  authMs: number;
  idMs: number;
  normalizeMs: number;
  operationMs: number;
  runnerMs: number;
  stateMs: number;
  totalMs: number;
}

export interface BrowserRemoteRuntimeTiming {
  argsEncodeMs: number;
  batchMs: number;
  beginMs: number;
  commitMs: number;
  handlerMs: number;
  mutationId: boolean;
  notifyMs: number;
  prepareMs: number;
  resultEncodeMs: number;
  totalMs: number;
}

export interface BrowserRemoteStats {
  max: number;
  mean: number;
  min: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  samples: number;
}

export interface BrowserRemoteBenchReport {
  artifact: {
    browserBundle: string;
    deployment: string;
    remoteUrl: string;
  };
  browser: "chromium";
  cache: {
    embeddedListFunction: string;
    embeddedListOmitsBody: boolean;
    embeddedSummaryKeys: string[];
    bodyEditCacheServes: number;
    bodyEditListWrites: number;
    bodyEditResultWrites: number;
    titleEditCacheServes: number;
    titleEditResultWrites: number;
  };
  generatedAt: string;
  iterations: number;
  lifecycle: {
    create: boolean;
    crdt: boolean;
    delete: boolean;
    plain: boolean;
  };
  notes: string[];
  remoteUrl: string;
  samples: BrowserRemoteBenchSample[];
  summaries: {
    deltaPeerApplyMs: BrowserRemoteStats;
    deltaPeerMs: BrowserRemoteStats;
    deltaQueryDeliveryMs: BrowserRemoteStats;
    directConsistencyMs: BrowserRemoteStats;
    directPeerMs: BrowserRemoteStats;
    embeddedAdmissionMs: BrowserRemoteStats;
    embeddedPeerMs: BrowserRemoteStats;
    embeddedRuntimeCommitMs: BrowserRemoteStats;
    embeddedRuntimeMs: BrowserRemoteStats;
    embeddedSettlementMs: BrowserRemoteStats;
  };
  suspicious: string[];
  unrelated: {
    directNetwork: BrowserRemoteNetworkEvidence;
    directTransitions: number;
    embeddedNetwork: BrowserRemoteNetworkEvidence;
    embeddedObserver: BrowserRemoteTickEvidence;
    embeddedTransitions: number;
  };
  version: 4;
  warmups: number;
}

export interface BrowserDirectPageState {
  armDocumentSlug(slug: string, timeoutMs: number): number;
  armDocumentTitle(title: string, timeoutMs: number): number;
  armMissing(title: string, timeoutMs: number): number;
  armTitle(title: string, timeoutMs: number): number;
  close(): Promise<void>;
  create(title: string, body: string): Promise<{ id: string }>;
  remove(id: string): Promise<void>;
  rows(): Array<{ _id: string; title: string }>;
  select(id: string): void;
  summaryKeys(): string[];
  listTransitionCount(): number;
  pointTransitionCount(): number;
  transitionCount(): number;
  update(id: string, title: string, updatedAt: number): Promise<{ consistencyMs: number }>;
  writeSlug(id: string, slug: string): Promise<{ consistencyMs: number }>;
  wait(id: number): Promise<number>;
}

export interface BrowserRemotePageState {
  accepted(): number;
  armBody(title: string, body: string, timeoutMs: number): number;
  armMissing(title: string, timeoutMs: number): number;
  cacheServeCount(): number;
  close(): Promise<void>;
  create(
    title: string,
    body: string,
  ): Promise<{ acceptedBefore: number; admissionMs: number; id: string; startedAt: number }>;
  eventCount(): number;
  evidenceSince(cursor: number): BrowserRemoteTickEvidence;
  remove(id: string): Promise<unknown>;
  resultWriteCount(): number;
  rows(): Array<{ _id: string; title: string }>;
  select(id: string): void;
  summaryKeys(): string[];
  listTransitionCount(): number;
  pointTransitionCount(): number;
  transitionCount(): number;
  update(
    id: string,
    title: string,
    updatedAt: number,
  ): Promise<{
    acceptedBefore: number;
    admission: BrowserRemoteAdmissionTiming;
    admissionMs: number;
    runtime: BrowserRemoteRuntimeTiming;
  }>;
  wait(id: number): Promise<number>;
  waitForPushAccepted(after: number): Promise<number>;
  write(
    id: string,
    body: { delete: number; index: number; insert: string },
  ): Promise<{
    acceptedBefore: number;
    admission: BrowserRemoteAdmissionTiming;
    admissionMs: number;
    runtime: BrowserRemoteRuntimeTiming;
    startedAt: number;
  }>;
}

export interface BrowserStartupPhaseTimings {
  opfsRegisterMs?: number;
  openSetupMs: number;
  storeCheckpointMs?: number;
  storeOpenMs?: number;
  storeSetupMs?: number;
  wasmBeforeInitMs?: number;
  wasmFetchMs?: number;
  wasmInstantiateMs?: number;
  wasmLoadMs?: number;
}

export interface BrowserScaleBenchOptions {
  clients: number;
  durationMs: number;
  out?: string;
  rows: number;
}

export interface MetalScaleBenchOptions {
  clients: number;
  out?: string;
  remoteUrl: string;
  revs: number;
  skipRevList?: boolean;
  timeoutMs?: number;
  writes: number;
}

export interface MetalReconnectVolumeBenchOptions {
  clients: number;
  deployment: string;
  out?: string;
  remoteUrl: string;
  revs: number;
  skipRevList?: boolean;
  timeoutMs?: number;
}

export interface BrowserLatencyBenchScenario {
  devtoolsOpen: boolean;
  rowCount: number;
  tabs: "one" | "two";
  watchActive: boolean;
}

export interface BrowserLatencyBenchSample {
  commitMs: number;
  envelopeMs: number;
  measuredMs: number;
  notifyMs: number;
  operation: string;
  outsideRuntimeMs: number;
  totalRuntimeMs: number;
}

export interface BrowserLatencyBenchResult extends BrowserLatencyBenchScenario {
  observedRows: number;
  samples: BrowserLatencyBenchSample[];
  seedMs: number;
  summaries: {
    commitMs: BenchStats;
    envelopeMs: BenchStats;
    measuredMs: BenchStats;
    notifyMs: BenchStats;
    outsideRuntimeMs: BenchStats;
    totalRuntimeMs: BenchStats;
  };
  suspicious: string[];
}

export interface BrowserLatencyBenchReport {
  browser: string;
  generatedAt: string;
  iterations: number;
  latencyP90BudgetMs: number;
  notes: string[];
  profile: "full" | "smoke";
  results: BrowserLatencyBenchResult[];
  rowCounts: number[];
  tabs: Array<"one" | "two">;
  version: 1;
  warmups: number;
}

export interface BrowserStartupBenchSample {
  closeMs: number;
  constructMs: number;
  firstQueryMs: number;
  importMs: number;
  operation: "attach" | "cold" | "reopen";
  phaseMs: BrowserStartupPhaseTimings;
  readyQueryMs: number;
  totalMs: number;
}

export interface BrowserStartupBenchResult {
  leaderReadyMs?: number;
  operation: "attach" | "cold" | "reopen";
  samples: BrowserStartupBenchSample[];
  summaries: {
    closeMs: BenchStats;
    constructMs: BenchStats;
    firstQueryMs: BenchStats;
    importMs: BenchStats;
    opfsRegisterMs: BenchStats;
    openSetupMs: BenchStats;
    readyQueryMs: BenchStats;
    storeCheckpointMs: BenchStats;
    storeOpenMs: BenchStats;
    storeSetupMs: BenchStats;
    totalMs: BenchStats;
    wasmBeforeInitMs: BenchStats;
    wasmFetchMs: BenchStats;
    wasmInstantiateMs: BenchStats;
    wasmLoadMs: BenchStats;
  };
}

export interface BrowserStartupBenchReport {
  browser: string;
  generatedAt: string;
  iterations: number;
  notes: string[];
  results: BrowserStartupBenchResult[];
  version: 2;
  warmups: number;
}

export interface BrowserScaleBenchSample {
  max: number;
  mean: number;
  min: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  samples: number;
}

export interface BrowserScaleBenchReport {
  browser: string;
  clients: number;
  durationMs: number;
  finalTitle: string;
  generatedAt: string;
  notes: string[];
  observerFinalTitles: Array<string | null>;
  observerUpdates: number[];
  rows: number;
  results: {
    allObserversSawFinal: boolean;
    fanoutWrites: number;
    seedMs: BrowserScaleBenchSample;
    startupMs: BrowserScaleBenchSample;
    streamConvergenceMs: BrowserScaleBenchSample;
    writeMs: BrowserScaleBenchSample;
  };
  version: 4;
}

export interface MetalScaleBenchReport {
  browser: string;
  clients: number;
  finalTitle: string;
  generatedAt: string;
  notes: string[];
  observerFinalTitles: Array<string | null>;
  observerRevCounts: Array<number | null>;
  observerStorageIds: string[];
  remoteTicks: {
    pullAttempted: number;
    pushAccepted: number;
    pushAttempted: number;
    pushConflicts: number;
    pushRebases: number;
    pushFailed: number;
    received: number;
    retainedRevisions: number;
    rowsApplied: number;
    sent: number;
    settlementsAcknowledged: number;
    storeJobs: number;
  };
  revs: number;
  results: {
    allObserversSawFinal: boolean;
    fanoutWrites: number;
    remotePullMs: BrowserScaleBenchSample;
    remotePushMs: BrowserScaleBenchSample;
    revCount: number | null;
    revCreateMs: BrowserScaleBenchSample;
    revCycleMs: BrowserScaleBenchSample;
    revListSkipped: boolean;
    revWriteMs: BrowserScaleBenchSample;
    settlementMs: BrowserScaleBenchSample;
    streamConvergenceMs: BrowserScaleBenchSample;
    writeMs: BrowserScaleBenchSample;
  };
  runId: string;
  version: 5;
  writes: number;
}

export interface MetalReconnectVolumeBenchReport {
  browser: string;
  clientFinalTitles: Array<string | null>;
  clientStorageIds: string[];
  clients: number;
  foregroundTitle: string;
  generatedAt: string;
  notes: string[];
  observerFinalTitle: string | null;
  observerStorageId: string;
  remoteTicks: {
    observer: MetalRemoteTickTotals;
    total: MetalRemoteTickTotals;
    writer: MetalRemoteTickTotals;
  };
  revs: number;
  runId: string;
  seedTitle: string;
  volumeFinalTitle: string;
  writerFinalTitle: string | null;
  writerStorageId: string;
  results: {
    finalConvergenceCorrect: boolean;
    firstLocalQueryMs: BrowserScaleBenchSample;
    foregroundDocWriteMs: BrowserScaleBenchSample;
    foregroundRevCreateMs: BrowserScaleBenchSample;
    localRowCountAtFirstQuery: number;
    localTitleAtFirstQuery: string | null;
    reconnectStartToFirstRemoteEventMs: BrowserScaleBenchSample;
    reconnectStartToConvergenceMs: BrowserScaleBenchSample;
    hostedRevFirstReadMs: BrowserScaleBenchSample;
    hostedRevReadMs: BrowserScaleBenchSample;
    hostedSeedVisible: boolean;
    localRevCount: number | null;
    remotePullMs: BrowserScaleBenchSample;
    revListSkipped: boolean;
    streamConvergenceMs: BrowserScaleBenchSample;
    storeJobs: number;
    offlineRevCreateMs: BrowserScaleBenchSample;
    offlineWriteMs: BrowserScaleBenchSample;
    seedMs: BrowserScaleBenchSample;
  };
  version: 3;
}

export type MetalRemoteTickTotals = MetalScaleBenchReport["remoteTicks"];

export class MetalWaitError extends Error {
  constructor(
    label: string,
    readonly lastState: unknown,
  ) {
    super(`Timed out waiting for ${label}. Last state: ${JSON.stringify(lastState)}`);
    this.name = "MetalWaitError";
  }
}

export interface BrowserScalePageState {
  readonly latestTitle: string | null;
  readonly updateCount: number;
  run(durationMs: number): Promise<{
    fanoutWrites: number;
    finalTitle: string;
    writeMs: BrowserScaleBenchSample;
  }>;
  waitForTitle(title: string): Promise<void>;
}

export interface MetalDocumentsSyncOptions {
  remoteUrl: string;
  timeoutMs?: number;
}

export interface MetalDocumentsSyncResult {
  conflictObserved: boolean;
  createIdStable: boolean;
  deviceCount: number;
  finalTitle: string;
  restoredTitle: string;
  runId: string;
  snapshotTitle: string;
}

export interface MetalDocument {
  _creationTime: number;
  _id: string;
  body: string;
  slug: string;
  title: string;
  updatedAt: number;
}

export interface MetalRevEntry {
  doc: MetalDocument | null;
  rev: {
    nodeId?: string;
    origin?: string;
    parentRevId?: string;
    rootId?: string;
    revId: string;
    status: string;
    updatedTime: number;
  };
}

export interface MetalEventSummary {
  conflicts?: unknown[];
  detail?: unknown;
  durationMs?: number;
  error?: string;
  name?: string;
  phase?: string;
  status?: string;
  tick?: {
    changedTables?: string[];
    pullAttempted?: number;
    pushAccepted?: number;
    pushAttempted?: number;
    pushConflicts?: number;
    pushRebases?: number;
    pushFailed?: number;
    pushed?: number;
    received?: number;
    reconnected?: boolean;
    retainedRevisions?: number;
    rowsApplied?: number;
    sent?: number;
    settlementsAcknowledged?: number;
    storeJobs?: number;
  };
  type?: string;
}

export interface MetalDeviceStatus {
  allDevtoolsRows: MetalDocument[];
  devtoolsRows: MetalDocument[];
  dirtyHeads: Array<Record<string, unknown>>;
  errors: string[];
  events: MetalEventSummary[];
  idMappings: Array<Record<string, unknown>>;
  projections: Array<Record<string, unknown>>;
  remoteTickTotals: MetalRemoteTickTotals;
  revs: Record<string, MetalRevEntry["rev"][] | { error: string }>;
  rows: MetalDocument[];
  firstRemoteEventAfterLastOpenMs: number | null;
  storageId: string;
}

export interface MetalDeviceState {
  close(): Promise<void>;
  create(title: string): Promise<string>;
  allDevtoolsRows(): Promise<MetalDocument[]>;
  devtoolsRows(): Promise<MetalDocument[]>;
  dirtyHeads(): Promise<Array<Record<string, unknown>>>;
  idMappings(): Promise<Array<Record<string, unknown>>>;
  projections(): Promise<Array<Record<string, unknown>>>;
  errors: string[];
  events: MetalEventSummary[];
  getSnapshot(id: string, revId: string): Promise<MetalRevEntry | null>;
  one(): Promise<MetalDocument>;
  open(remoteEnabled: boolean): Promise<void>;
  openTimed(remoteEnabled: boolean): Promise<MetalOpenTiming>;
  remoteTickTotals: MetalRemoteTickTotals;
  restoreSnapshot(id: string, revId: string): Promise<MetalRevEntry | null>;
  revs(id: string): Promise<MetalRevEntry["rev"][]>;
  rows(): Promise<MetalDocument[]>;
  snapshot(id: string): Promise<MetalRevEntry | null>;
  firstRemoteEventAfterLastOpenMs(): number | null;
  setWatchDocument(id: string | null): Promise<void>;
  storageId: string;
  writeBody(id: string, body: { delete: number; index: number; insert: string }): Promise<void>;
  writeDraft(id: string, title: string): Promise<void>;
}

export type MetalWatchTarget =
  | { kind: "document"; id: string }
  | { kind: "list" }
  | { kind: "none" };

export interface MetalOpenTiming {
  firstLocalQueryMs: number;
  localRowCount: number;
  localTitle: string | null;
}

export interface BenchStats {
  max: number;
  mean: number;
  min: number;
  p50: number;
  p90: number;
}
