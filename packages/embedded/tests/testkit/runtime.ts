import { tmpdir } from "node:os";
import { join } from "node:path";

import { getTimerTime } from "../../src/time";

let counter = 0;

export function uniqueName(prefix: string): string {
  counter += 1;
  return `${prefix}_${getTimerTime()}_${counter}`;
}

export function temporaryPath(prefix = "embedded-test"): string {
  return join(tmpdir(), `${uniqueName(prefix)}.sqlite`);
}
