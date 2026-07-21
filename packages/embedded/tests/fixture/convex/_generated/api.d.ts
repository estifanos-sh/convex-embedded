/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as client from "../client.js";
import type * as crdt from "../crdt.js";
import type * as documents from "../documents.js";
import type * as embedded from "../embedded.js";
import type * as file from "../file.js";
import type * as hosted from "../hosted.js";
import type * as invalid from "../invalid.js";
import type * as migrations from "../migrations.js";
import type * as mutation from "../mutation.js";
import type * as replay from "../replay.js";
import type * as remote from "../remote.js";
import type * as revision from "../revision.js";
import type * as seed from "../seed.js";
import type * as time from "../time.js";

import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  client: typeof client;
  crdt: typeof crdt;
  documents: typeof documents;
  embedded: typeof embedded;
  file: typeof file;
  hosted: typeof hosted;
  invalid: typeof invalid;
  migrations: typeof migrations;
  mutation: typeof mutation;
  replay: typeof replay;
  remote: typeof remote;
  revision: typeof revision;
  seed: typeof seed;
  time: typeof time;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">>;

export declare const components: {
  embedded: import("@convex-dev/embedded/_generated/component.js").ComponentApi<"embedded">;
  migrations: import("@convex-dev/migrations/_generated/component.js").ComponentApi<"migrations">;
};
