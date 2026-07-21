declare module "virtual:convex-embedded" {
  export const modules: import("./runtime/runner").ModuleMap;
  export const embeddedManifest: import("./bundler").EmbeddedFunctionManifest;
  export const embeddedSchema: import("./bundler").EmbeddedGeneratedSchema;
}

declare module "virtual:convex-embedded/identity" {
  export const embeddedIdentity: {
    moduleGraphHash: string;
    schemaHash: string;
  };
}
