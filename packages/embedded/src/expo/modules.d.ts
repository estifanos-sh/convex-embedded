declare module "expo" {
  export function requireOptionalNativeModule<T>(name: string): T | null;
}
