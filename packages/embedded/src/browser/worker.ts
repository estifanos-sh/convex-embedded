import { instantiateNapiModuleSync, MessageHandler, WASI } from "@napi-rs/wasm-runtime";

import { opfsStubImports } from "./opfs";

const handler = new MessageHandler({
  onLoad({ wasmMemory, wasmModule }: { wasmMemory: unknown; wasmModule: unknown }) {
    const wasi = new WASI({
      print: (...args: unknown[]) => console.log(...args),
      printErr: (...args: unknown[]) => console.error(...args),
    });
    return instantiateNapiModuleSync(wasmModule, {
      childThread: true,
      wasi,
      overwriteImports(importObject: {
        emnapi?: object;
        env?: Record<string, unknown>;
        napi?: object;
      }) {
        importObject.env = {
          ...importObject.env,
          ...importObject.napi,
          ...importObject.emnapi,
          ...opfsStubImports(),
          memory: wasmMemory,
        };
      },
    });
  },
});

(globalThis as typeof globalThis & { onmessage: (event: unknown) => void }).onmessage = (event) =>
  handler.handle(event);
