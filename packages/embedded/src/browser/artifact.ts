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

type BrowserWorker = {
  addEventListener(type: "message", callback: (event: unknown) => void): void;
  postMessage(message: unknown): void;
  removeEventListener(type: "message", callback: (event: unknown) => void): void;
};

declare const Worker: new (url: URL, options: { name?: string; type: "module" }) => BrowserWorker;
declare const WebAssembly: {
  Memory: new (options: { initial: number; maximum: number; shared: boolean }) => {
    buffer: ArrayBufferLike;
  };
};

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
    open(name: string, identityKey?: string): unknown;
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
   * headroom; shared memory grows on demand up to the 4GiB maximum.
   */
  initialMemoryPages?: number;
  /** Optional OPFS directory bridge used by the WASM imports. */
  opfs?: OpfsDirectory;
}

/**
 * Expected browser WASM storage artifact API version.
 *
 * @internal
 */
export const WASM_API_VERSION = 6;

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
  loadOptions.debug?.("worker:wasm:fetch:start");
  const bytes = options.bytes ?? (await fetchPackagedWasm());
  loadOptions.debug?.("worker:wasm:fetch:done", { bytes: bytes.byteLength });
  loadOptions.debug?.("worker:wasm:instantiate:start");
  const napiModule = await instantiateStorageModule(
    bytes,
    options.worker ?? defaultWorker,
    loadOptions.opfs,
    loadOptions.debug,
    loadOptions.initialMemoryPages,
  );
  loadOptions.debug?.("worker:wasm:instantiate:done");
  return validateWasmModule(napiModule.exports);
}

/** Headroom on top of the artifact's declared memory minimum: thread stacks and early heap. */
const MEMORY_HEADROOM_PAGES = 256;

/** Fallback when the artifact's declared minimum cannot be parsed. */
const FALLBACK_INITIAL_PAGES = 4000;

const MAX_MEMORY_PAGES = 65536;

async function instantiateStorageModule(
  wasm: ArrayBuffer | Uint8Array,
  worker: () => BrowserWorker,
  opfs: OpfsDirectory | undefined,
  debug: ((phase: string, detail?: unknown) => void) | undefined,
  initialMemoryPages?: number,
): Promise<NapiModule> {
  assertCrossOriginIsolated();
  const context = getDefaultContext();
  const wasi = new WASI({ version: "preview1" });
  // napi-rs requires shared WASM memory so worker-pool and OPFS imports see the same store.
  const declared = declaredMemoryPages(wasm);
  const initial = Math.min(
    initialMemoryPages ??
      (declared === undefined ? FALLBACK_INITIAL_PAGES : declared + MEMORY_HEADROOM_PAGES),
    MAX_MEMORY_PAGES,
  );
  debug?.("worker:wasm:memory", { declared, initial });
  const memory = new WebAssembly.Memory({
    initial,
    maximum: MAX_MEMORY_PAGES,
    shared: true,
  });
  const { napiModule } = await instantiateNapiModule(wasm, {
    asyncWorkPoolSize: 1,
    context,
    onCreateWorker: worker,
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
  });
  return napiModule;
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
 * Returns `undefined` on any parse surprise — the caller falls back to a safe default.
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
        offset += leb();
        offset += leb();
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

async function fetchPackagedWasm(): Promise<ArrayBuffer> {
  const url = new URL("./wasm/index.wasm", import.meta.url);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to load browser WASM storage artifact: ${response.status}`);
  }
  // The ArrayBuffer is owned by the module instantiator after fetch; callers do not retain it.
  return response.arrayBuffer();
}

function defaultWorker(): BrowserWorker {
  return new Worker(new URL("./browser-worker.mjs", import.meta.url), {
    name: "convex-embedded",
    type: "module",
  });
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
