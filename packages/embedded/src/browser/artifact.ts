/**
 * Browser WASM artifact loading internals for embedded Convex storage.
 *
 * @remarks
 * These exports support tests and the browser runtime. Applications normally
 * use `@convex-dev/embedded/browser` and let the package load its bundled WASM
 * artifact.
 *
 * @packageDocumentation
 */
import {
  getDefaultContext,
  instantiateNapiModule,
  type NapiModule,
  WASI,
} from "@napi-rs/wasm-runtime";
import { OpfsDirectory, opfsImports } from "./opfs";
import { EMBEDDED_STORAGE_ABI_VERSION } from "../abi";
import { EmbeddedError } from "../error";

type BrowserWorker = {
  addEventListener(type: "message", callback: (event: unknown) => void): void;
  addEventListener(type: "error" | "messageerror", callback: (event: unknown) => void): void;
  postMessage(message: unknown): void;
  removeEventListener(type: "message", callback: (event: unknown) => void): void;
  terminate?(): void;
};

/**
 * Tracks the emnapi async-work pthreads spawned for one store instance so store-instance recovery
 * can terminate the whole pool before grafting a fresh instance into the retained runtime.
 *
 * @internal
 */
export class PthreadRegistry {
  private readonly workers = new Set<BrowserWorker>();

  register(worker: BrowserWorker): void {
    this.workers.add(worker);
  }

  terminateAll(): void {
    for (const worker of this.workers) {
      try {
        worker.terminate?.();
      } catch {}
    }
    this.workers.clear();
  }

  get size(): number {
    return this.workers.size;
  }
}

declare const Worker: new (url: URL, options: { name?: string; type: "module" }) => BrowserWorker;
interface WasmCompiledModule {
  readonly __wasmCompiledModule: unique symbol;
}
declare const WebAssembly: {
  Memory: new (options: { initial: number; maximum: number; shared: boolean }) => {
    buffer: ArrayBufferLike;
  };
  compileStreaming?: (source: Promise<Response>) => Promise<WasmCompiledModule>;
};

type WasmProgram = ArrayBuffer | Uint8Array | WasmCompiledModule;

interface WasmInstance {
  exports: Record<string, unknown>;
}

/**
 * Loaded napi-rs WASM module shape expected by the browser adapter.
 *
 * @internal
 */
export interface WasmModule {
  /** Storage artifact API version exported by the Rust/WASM module. */
  apiVersion(): number;
  /** Store constructor exported by the Rust/WASM module. */
  Store: {
    /** Opens an embedded store for the given browser storage path. */
    open(name: string, selectorKey?: string, defaultIdentityKey?: string): unknown;
  };
}

/**
 * Browser WASM artifact source.
 *
 * @remarks
 * This type exists for tests and custom loaders. Production browser clients
 * usually rely on the packaged WASM artifact discovered from `import.meta.url`.
 *
 * @internal
 */
export type WasmSource =
  | WasmModule
  | Promise<WasmModule>
  | (() => WasmModule | Promise<WasmModule>)
  | {
      /** Raw WASM bytes to instantiate instead of fetching the packaged artifact. */
      bytes?: ArrayBuffer | Uint8Array;
      /** Worker factory used by napi-rs during WASM initialization. */
      worker?: () => BrowserWorker;
    };

/**
 * Options for loading the browser Rust/WASM storage artifact.
 *
 * @internal
 */
export interface LoadWasmOptions {
  /** Optional debug sink for worker initialization phases. */
  debug?: (phase: string, detail?: unknown) => void;
  /**
   * Initial shared-memory size in 64KiB pages. Defaults to the artifact's declared minimum plus
   * headroom; shared memory grows on demand up to the 512 MiB maximum.
   */
  initialMemoryPages?: number;
  /** Optional OPFS directory bridge used by the WASM imports. */
  opfs?: OpfsDirectory;
  /** Optional registry that collects spawned pthreads so recovery can terminate the pool. */
  registry?: PthreadRegistry;
}

/**
 * Expected browser WASM storage artifact API version.
 *
 * @internal
 */
export const WASM_API_VERSION = EMBEDDED_STORAGE_ABI_VERSION;

/**
 * Thrown when the shared linear memory backing the store cannot be reserved because the device
 * memory budget is exhausted. Surfaces through the runtime's boot-error path with an actionable
 * message instead of the raw engine `RangeError`.
 *
 * @internal
 */
export class EmbeddedInsufficientMemoryError extends EmbeddedError {
  constructor(cause?: unknown) {
    super(
      "EMBEDDED_STORAGE",
      "Insufficient memory to start the embedded store on this device. Close other tabs or apps and reload.",
      { cause },
    );
    this.name = "EmbeddedInsufficientMemoryError";
  }
}

/**
 * Loads and validates the browser Rust/WASM storage artifact.
 *
 * @param source - Optional explicit module, loader, bytes, or worker override.
 * @param loadOptions - Internal loader diagnostics and OPFS bridge options.
 * @returns A validated WASM storage module.
 * @throws If cross-origin isolation is unavailable, the packaged artifact
 * cannot be fetched, WASM instantiation fails, or the artifact API is
 * incompatible.
 *
 * @internal
 */
export async function loadWasmModule(
  source: WasmSource | undefined,
  loadOptions: LoadWasmOptions = {},
): Promise<WasmModule> {
  if (isExplicitModuleSource(source)) {
    const module = typeof source === "function" ? await source() : await source;
    return validateWasmModule(module);
  }
  const options = isLoadOptions(source) ? source : {};
  loadOptions.debug?.("worker:wasm:instantiate:start");
  const napiModule = await instantiateStorageModule(
    options.bytes,
    options.worker ?? (() => defaultWorker(loadOptions.debug)),
    loadOptions.opfs,
    loadOptions.debug,
    loadOptions.initialMemoryPages,
    loadOptions.registry,
  );
  loadOptions.debug?.("worker:wasm:instantiate:done");
  return validateWasmModule(napiModule.exports);
}

/** Headroom on top of the artifact's declared memory minimum: thread stacks and early heap. */
const MEMORY_HEADROOM_PAGES = 256;

/**
 * Reviewed memory-import minimum (64KiB pages) of the packaged storage artifact. Sizes the shared
 * memory on the streaming path, where module bytes are never buffered for parsing. An artifact whose
 * minimum grows past this fails loudly at instantiation, which the browser runtime test exercises
 * against the real artifact.
 */
const PACKAGED_ARTIFACT_MEMORY_PAGES = 1009;

/**
 * Shared linear memory ceiling: 512 MiB. A shared memory cannot relocate when it grows, and engines
 * may reserve its whole `maximum` at construction. A client store's working set is tens of MB, so
 * 512 MiB is ample while keeping the reservation inside constrained device budgets. Raise uniformly
 * if a real workload needs it — never fork by platform.
 */
const MAX_MEMORY_PAGES = 8192;

async function instantiateStorageModule(
  bytes: ArrayBuffer | Uint8Array | undefined,
  worker: () => BrowserWorker,
  opfs: OpfsDirectory | undefined,
  debug: ((phase: string, detail?: unknown) => void) | undefined,
  initialMemoryPages?: number,
  registry?: PthreadRegistry,
): Promise<NapiModule> {
  assertCrossOriginIsolated();
  const context = getDefaultContext();
  const wasi = new WASI({ version: "preview1" });
  const program = await resolveWasmProgram(bytes, debug);
  const initial = Math.min(initialMemoryPages ?? program.initialPages, MAX_MEMORY_PAGES);
  debug?.("worker:wasm:memory", {
    initial,
    maximum: MAX_MEMORY_PAGES,
    streamed: program.streamed,
  });
  const memory = createSharedMemory(initial);
  const trackedWorker = registry
    ? () => {
        const spawned = worker();
        registry.register(spawned);
        return spawned;
      }
    : worker;
  const { napiModule } = await instantiateNapiModule(
    program.source as Parameters<typeof instantiateNapiModule>[0],
    {
      asyncWorkPoolSize: 4,
      context,
      onCreateWorker: trackedWorker,
      wasi,
      beforeInit({ instance }: { instance: WasmInstance }) {
        debug?.("worker:wasm:before-init:start");
        for (const name of Object.keys(instance.exports)) {
          if (name.startsWith("__napi_register__")) {
            debug?.("worker:wasm:napi-register:start", { name });
            const register = instance.exports[name];
            if (typeof register === "function") register();
            debug?.("worker:wasm:napi-register:done", { name });
          }
        }
        debug?.("worker:wasm:before-init:done");
      },
      overwriteImports(importObject: {
        env?: Record<string, unknown>;
        napi?: object;
        emnapi?: object;
      }) {
        importObject.env = {
          ...importObject.env,
          ...importObject.napi,
          ...importObject.emnapi,
          ...(opfs ? opfsImports(opfs, memory) : {}),
          memory,
        };
        return importObject;
      },
    },
  );
  return napiModule;
}

async function resolveWasmProgram(
  bytes: ArrayBuffer | Uint8Array | undefined,
  debug: ((phase: string, detail?: unknown) => void) | undefined,
): Promise<{ source: WasmProgram; initialPages: number; streamed: boolean }> {
  if (bytes !== undefined) {
    return {
      source: bytes,
      initialPages: initialMemoryPagesFromDeclared(declaredMemoryPages(bytes)),
      streamed: false,
    };
  }
  const url = new URL("./wasm/index.wasm", import.meta.url);
  if (typeof WebAssembly.compileStreaming === "function") {
    try {
      debug?.("worker:wasm:fetch:stream:start");
      const source = await WebAssembly.compileStreaming(fetch(url));
      debug?.("worker:wasm:fetch:stream:done");
      return {
        source,
        initialPages: PACKAGED_ARTIFACT_MEMORY_PAGES + MEMORY_HEADROOM_PAGES,
        streamed: true,
      };
    } catch (error) {
      debug?.("worker:wasm:fetch:stream:fallback", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  debug?.("worker:wasm:fetch:buffered:start");
  const buffered = await fetchPackagedWasm(url);
  debug?.("worker:wasm:fetch:buffered:done", { bytes: buffered.byteLength });
  return {
    source: buffered,
    initialPages: initialMemoryPagesFromDeclared(declaredMemoryPages(buffered)),
    streamed: false,
  };
}

function createSharedMemory(initial: number): { buffer: ArrayBufferLike } {
  try {
    return new WebAssembly.Memory({ initial, maximum: MAX_MEMORY_PAGES, shared: true });
  } catch (error) {
    throw new EmbeddedInsufficientMemoryError(error);
  }
}

function initialMemoryPagesFromDeclared(declared: number | undefined): number {
  if (declared === undefined) {
    throw new Error(
      "browser WASM artifact memory import could not be parsed; pass initialMemoryPages only " +
        "for an explicitly reviewed custom artifact.",
    );
  }
  return declared + MEMORY_HEADROOM_PAGES;
}

const IMPORT_KIND_FUNCTION = 0x00;
const IMPORT_KIND_TABLE = 0x01;
const IMPORT_KIND_MEMORY = 0x02;
const IMPORT_KIND_GLOBAL = 0x03;

/**
 * Reads the artifact's declared minimum memory size (in pages) from its import section: the
 * 8-byte header, then each section until the import section, then each import entry (two
 * length-prefixed names, a kind byte, and the kind's payload) until the memory import's limits.
 * `WebAssembly.Module.imports()` does not expose limits, so this walks the binary directly.
 * Returns `undefined` on any parse surprise; the caller then refuses to guess unless an explicit
 * reviewed memory size was provided.
 */
function declaredMemoryPages(wasm: ArrayBuffer | Uint8Array): number | undefined {
  try {
    const bytes = wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm);
    if (bytes.length < 8) return undefined;
    let offset = 8;
    const leb = (): number => {
      let result = 0;
      let shift = 0;
      while (true) {
        const byte = bytes[offset];
        if (byte === undefined) throw new Error("truncated wasm");
        offset += 1;
        result |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) return result >>> 0;
        shift += 7;
      }
    };
    const skipName = (): void => {
      const length = leb();
      offset += length;
    };
    while (offset < bytes.length) {
      const sectionId = bytes[offset];
      offset += 1;
      const sectionSize = leb();
      const sectionEnd = offset + sectionSize;
      if (sectionId !== 2) {
        offset = sectionEnd;
        continue;
      }
      const importCount = leb();
      for (let i = 0; i < importCount; i += 1) {
        skipName();
        skipName();
        const kind = bytes[offset];
        offset += 1;
        switch (kind) {
          case IMPORT_KIND_FUNCTION:
            leb();
            break;
          case IMPORT_KIND_TABLE:
            offset += 1;
            skipLimits(leb);
            break;
          case IMPORT_KIND_MEMORY: {
            const flags = leb();
            const min = leb();
            if (flags & 0x01) leb();
            return min;
          }
          case IMPORT_KIND_GLOBAL:
            offset += 2;
            break;
          default:
            return undefined;
        }
      }
      return undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function skipLimits(leb: () => number): void {
  const flags = leb();
  leb();
  if (flags & 0x01) leb();
}

function assertCrossOriginIsolated(): void {
  if ((globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true) return;
  throw new Error(
    "ConvexEmbeddedClient browser storage requires cross-origin isolation. Serve the app with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp.",
  );
}

async function fetchPackagedWasm(url: URL): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to load browser WASM storage artifact: ${response.status}`);
  }
  return response.arrayBuffer();
}

function defaultWorker(debug?: (phase: string, detail?: unknown) => void): BrowserWorker {
  const url = new URL("./thread/browser-worker.mjs", import.meta.url);
  debug?.("worker:wasm:thread:create", { url: url.toString() });
  const worker = new Worker(url, {
    name: "convex-embedded",
    type: "module",
  });
  worker.addEventListener("error", (event) => {
    debug?.("worker:wasm:thread:error", { message: threadEventMessage(event) });
  });
  worker.addEventListener("messageerror", (event) => {
    debug?.("worker:wasm:thread:messageerror", { message: threadEventMessage(event) });
  });
  return worker;
}

function threadEventMessage(event: unknown): string {
  const value = event as { error?: unknown; message?: unknown };
  if (value.error instanceof Error) return value.error.message;
  if (typeof value.message === "string" && value.message.length > 0) return value.message;
  return "embedded storage worker thread crashed";
}

function validateWasmModule(value: unknown): WasmModule {
  const module = value as Partial<WasmModule>;
  if (typeof module.apiVersion !== "function") {
    throw new Error("browser WASM artifact did not export apiVersion");
  }
  const version = module.apiVersion();
  if (version !== WASM_API_VERSION) {
    throw new Error(
      `browser WASM artifact API version mismatch: expected ${WASM_API_VERSION}, got ${version}`,
    );
  }
  if (typeof module.Store?.open !== "function") {
    throw new Error("browser WASM artifact did not export Store.open");
  }
  return module as WasmModule;
}

function isExplicitModuleSource(
  source: WasmSource | undefined,
): source is WasmModule | Promise<WasmModule> | (() => WasmModule | Promise<WasmModule>) {
  return (
    typeof source === "function" || Boolean(source && ("apiVersion" in source || "then" in source))
  );
}

function isLoadOptions(source: WasmSource | undefined): source is {
  bytes?: ArrayBuffer | Uint8Array;
  worker?: () => BrowserWorker;
} {
  return Boolean(source && typeof source === "object" && ("bytes" in source || "worker" in source));
}
