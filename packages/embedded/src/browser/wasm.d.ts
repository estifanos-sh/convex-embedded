declare module "@napi-rs/wasm-runtime" {
  export interface NapiModule {
    exports: unknown;
  }

  export class WASI {
    constructor(options?: Record<string, unknown>);
  }

  export class MessageHandler {
    constructor(options: { onLoad(input: { wasmMemory: unknown; wasmModule: unknown }): unknown });
    handle(event: unknown): void;
  }

  export function getDefaultContext(): unknown;

  export function instantiateNapiModule(
    wasm: ArrayBuffer | Uint8Array,
    options: Record<string, unknown>,
  ): Promise<{ napiModule: NapiModule }>;

  export function instantiateNapiModuleSync(
    wasmModule: unknown,
    options: Record<string, unknown>,
  ): unknown;
}
