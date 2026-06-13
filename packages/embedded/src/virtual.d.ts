declare module "virtual:convex-embedded" {
  export const schema: import("./schema").ConvexEmbeddedSchema;
  export const modules: import("./runtime/runner").ModuleMap;
}

declare module "virtual:convex-embedded/identity" {
  export const embeddedIdentity: {
    moduleGraphHash: string;
    schemaHash: string;
  };
}
