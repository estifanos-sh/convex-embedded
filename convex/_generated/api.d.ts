/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as crdt from "../crdt.js";
import type * as documents from "../documents.js";
import type * as embedded from "../embedded.js";
import type * as files from "../files.js";
import type * as generated_embedded from "../generated/embedded.js";
import type * as hosted from "../hosted.js";
import type * as http from "../http.js";
import type * as migrations from "../migrations.js";
import type * as remote from "../remote.js";
import type * as rev from "../rev.js";
import type * as schedule from "../schedule.js";
import type * as staticHosting from "../staticHosting.js";
import type * as time from "../time.js";
import type * as upload from "../upload.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  crdt: typeof crdt;
  documents: typeof documents;
  embedded: typeof embedded;
  files: typeof files;
  "generated/embedded": typeof generated_embedded;
  hosted: typeof hosted;
  http: typeof http;
  migrations: typeof migrations;
  remote: typeof remote;
  rev: typeof rev;
  schedule: typeof schedule;
  staticHosting: typeof staticHosting;
  time: typeof time;
  upload: typeof upload;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  embedded: import("@convex-dev/embedded/_generated/component.js").ComponentApi<"embedded">;
  migrations: import("@convex-dev/migrations/_generated/component.js").ComponentApi<"migrations">;
  staticHosting: import("@convex-dev/static-hosting/_generated/component.js").ComponentApi<"staticHosting">;
};
