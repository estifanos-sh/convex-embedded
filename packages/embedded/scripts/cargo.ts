import { tmpdir } from "node:os";
import { resolve } from "node:path";

export function cargoTarget(repoRoot: string): string {
  const configured = process.env.CARGO_TARGET_DIR;
  return configured ? resolve(repoRoot, configured) : resolve(tmpdir(), "embedded-target");
}
