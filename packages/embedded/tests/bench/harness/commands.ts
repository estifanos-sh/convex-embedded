import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getTimerTime } from "../../../src/time.js";
import {
  runMetalDocumentsSync,
  runMetalReconnectVolumeBenchmark,
  runMetalScaleBenchmark,
} from "./metal.js";
import {
  readMetalReconnectVolumeBenchOptions,
  readMetalScaleBenchOptions,
  resolveBenchOutPath,
} from "./options.js";
import {
  browserDistPath,
  metalReconnectVolumeBenchOutPath,
  metalScaleBenchOutPath,
} from "./paths.js";
import { MetalWaitError } from "./types.js";
import type {
  MetalDocumentsSyncOptions,
  MetalReconnectVolumeBenchOptions,
  MetalScaleBenchOptions,
  PlaywrightCommandContext,
} from "./types.js";

export const metalCommands = {
  embeddedMetalScaleBenchmark: async (commandContext: unknown, options: MetalScaleBenchOptions) => {
    const context = commandContext as PlaywrightCommandContext;
    const benchOptions = readMetalScaleBenchOptions(options);
    const browserUrl = `/@fs${browserDistPath}?metal-scale=${getTimerTime()}`;
    const pageUrl = new URL("/__convex_embedded_page", context.page.url()).toString();
    const outPath = resolveBenchOutPath(benchOptions.out, metalScaleBenchOutPath);
    mkdirSync(path.dirname(outPath), { recursive: true });
    try {
      const report = await runMetalScaleBenchmark(context, pageUrl, browserUrl, benchOptions);
      writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      return { outPath, report };
    } catch (error) {
      writeFileSync(
        outPath,
        `${JSON.stringify(
          {
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            generatedAt: new Date().toISOString(),
            kind: "metal-scale-failure",
            ...(error instanceof MetalWaitError ? { lastState: error.lastState } : {}),
            stack: error instanceof Error ? error.stack : undefined,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      throw error;
    }
  },
  embeddedMetalReconnectVolumeBenchmark: async (
    commandContext: unknown,
    options: MetalReconnectVolumeBenchOptions,
  ) => {
    const context = commandContext as PlaywrightCommandContext;
    const benchOptions = readMetalReconnectVolumeBenchOptions(options);
    const browserUrl = `/@fs${browserDistPath}?metal-reconnect-volume=${getTimerTime()}`;
    const pageUrl = new URL("/__convex_embedded_page", context.page.url()).toString();
    const outPath = resolveBenchOutPath(benchOptions.out, metalReconnectVolumeBenchOutPath);
    mkdirSync(path.dirname(outPath), { recursive: true });
    try {
      const report = await runMetalReconnectVolumeBenchmark(
        context,
        pageUrl,
        browserUrl,
        benchOptions,
      );
      writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      return { outPath, report };
    } catch (error) {
      writeFileSync(
        outPath,
        `${JSON.stringify(
          {
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            generatedAt: new Date().toISOString(),
            kind: "metal-reconnect-volume-failure",
            ...(error instanceof MetalWaitError ? { lastState: error.lastState } : {}),
            stack: error instanceof Error ? error.stack : undefined,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      throw error;
    }
  },
  embeddedMetalDocumentsSync: async (
    commandContext: unknown,
    options: MetalDocumentsSyncOptions,
  ) => {
    const context = commandContext as PlaywrightCommandContext;
    const browserUrl = `/@fs${browserDistPath}?metal=${getTimerTime()}`;
    const pageUrl = new URL("/__convex_embedded_page", context.page.url()).toString();
    return await runMetalDocumentsSync(context, pageUrl, browserUrl, options);
  },
};
