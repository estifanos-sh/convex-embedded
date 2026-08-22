---
title: Configuration reference
description: Compare browser, Expo, Node, Vite, Metro, and Unplugin configuration options.
---

## Browser client

```ts
new ConvexEmbeddedClient({ url });
```

| Option | Type     | Default | Description                                          |
| ------ | -------- | ------- | ---------------------------------------------------- |
| `url`  | `string` | none    | Convex deployment URL; omit for local-only execution |

The browser's modules, schema, worker, and WASM assets come from the bundler
integration rather than constructor options.

## Expo client

```ts
new ConvexEmbeddedClient({
  operationTimeoutMs,
  path,
  receiveTimeoutMs,
  url,
});
```

| Option               | Type     | Default                   | Description                                 |
| -------------------- | -------- | ------------------------- | ------------------------------------------- |
| `path`               | `string` | `convex-embedded.sqlite3` | Database path or app-data-relative filename |
| `url`                | `string` | none                      | Convex deployment URL                       |
| `receiveTimeoutMs`   | `number` | runtime default           | One native remote receive timeout           |
| `operationTimeoutMs` | `number` | runtime default           | Hosted query, mutation, and action timeout  |

## Node client

```ts
new ConvexEmbeddedClient({ local, modules, path, schema, url });
```

| Option    | Required | Description                                     |
| --------- | -------- | ----------------------------------------------- |
| `schema`  | Yes      | Live Embedded schema definition                 |
| `modules` | Yes      | Convex modules keyed by module path             |
| `path`    | Yes      | Writable SQLite database path                   |
| `local`   | No       | Device modules keyed relative to the local root |
| `url`     | No       | Convex deployment URL                           |

## Vite and Unplugin

```ts
convexEmbedded({
  convexDir,
  disabled,
  generatedPath,
  local,
  schema,
  schemaPath,
});
```

| Option          | Default                 | Description                                               |
| --------------- | ----------------------- | --------------------------------------------------------- |
| `schema`        | required                | Imported live schema used to generate the device contract |
| `convexDir`     | `convex`                | Convex source directory relative to the project root      |
| `schemaPath`    | `schema.ts`             | Schema path relative to `convexDir`                       |
| `generatedPath` | `embedded.generated.ts` | Generated contract path relative to `convexDir`           |
| `local`         | none                    | One device root or an array of roots                      |
| `disabled`      | `false`                 | Return no active Embedded integration                     |

## Metro

Metro accepts the same schema and source-path options. Its optional `root`
defaults to Metro's `projectRoot`, then `process.cwd()`. `disabled: true`
returns the original Metro configuration unchanged.
