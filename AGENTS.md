- don't run the dev server, that is manually handled by another proccess
- we use vp and pnpm

--- project-doc ---

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

## Lexicon - canonical verb dictionary for @convex-dev/embedded

Use this lexicon for authored code in this repo. Convex API names, platform API
names, generated files, and package/tool-required config names may keep their
native spellings.

| Domain                          | Canonical verb                | Meaning                                                          | Avoid / rewrite                                               |
| ------------------------------- | ----------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------- |
| Access current state            | `get*`                        | Cheap in-memory or already-local lookup                          | `fetch*`, `load*`                                             |
| Read from storage               | `read*`                       | May touch local storage or durable state                         | `lookup*`, `find*`                                            |
| Load dependency/subsystem       | `load*`                       | Bring module, artifact, native binding, or subsystem into memory | `init*` unless mutating setup, `resolve*`                     |
| Remote/network retrieval        | `fetch*`                      | Actual network request                                           | `get*`                                                        |
| Gather many values              | `gather*`                     | Aggregate from multiple local sources                            | `collect*` except Convex query terminals                      |
| Extract part of a value         | `extract*`                    | Pull a field/sub-value from a structure                          | `get*` when transformation occurs                             |
| Convex query terminal           | `collect`                     | Terminal that materializes a Convex query                        | Non-query `collect*`                                          |
| Add new durable data            | `insert*`                     | Create a record that must not already exist                      | `add*`, `put*`                                                |
| Replace whole value             | `replace*`                    | Whole-record overwrite                                           | `update*`, `put*`                                             |
| Partial change                  | `patch*`                      | Partial durable update                                           | `modify*`, `update*`                                          |
| Delete durable data             | `delete*`                     | Remove persisted record                                          | `remove*` for durable data                                    |
| Detach local reference          | `remove*` / `detach*`         | Remove from set/map/listener without deleting durable data       | `delete*`                                                     |
| Empty collection                | `clear*`                      | Remove every local entry or reset local collection               | `deleteAll*`                                                  |
| Persist local data              | `store*` / `write*`           | Store object or write bytes                                      | `persist*`, `put*`                                            |
| Construct object                | `create*`                     | Make a new instance/value with identity or lifecycle             | `make*`                                                       |
| Construct derived config/result | `build*`                      | Assemble derived object without durable identity                 | `make*`                                                       |
| Convert value                   | `to*`                         | Synchronous type/shape conversion                                | `resolve*`                                                    |
| Binary/text codec               | `encode*` / `decode*`         | Bytes or transport encoding                                      | `serialize*` / `deserialize*` unless external API requires it |
| Parse input                     | `parse*`                      | String/unknown input to validated typed value                    | `decode*` unless bytes/protocol                               |
| Predicates                      | `is*`, `has*`, `should*`      | Boolean checks                                                   | `check*` for pure predicates                                  |
| Execute user/runtime work       | `run*`                        | Run a task/job/test body                                         | `execute*` unless external API requires it                    |
| Handle event/request            | `handle*` / `on*`             | Event/request handler                                            | `process*` for simple dispatch                                |
| Schedule later work             | `schedule*`                   | Timer/background enqueue                                         | `queue*` only for queue data structure                        |
| Format display/debug text       | `format*`                     | Human-readable string formatting                                 | `fmt*`                                                        |
| Subscribe lifecycle             | `subscribe*` / `unsubscribe*` | Register/unregister reactive listener                            | `listen*`, `unsub*`                                           |
| Replication                     | `replicate*` / `pull*`        | Sync engine protocol or remote replication                       | Generic `sync*`                                               |

Authored file and folder names under package source, tests, and scripts should
be one lowercase word. Use folders for broad, meaningful scopes instead of
kebab-case, camelCase, snake_case, or folder-per-test segmentation.

Internal storage-shaped surfaces group operations as one-word noun namespaces
whose methods are one-word lexicon verbs — `doc.read`, `key.scan`, `blob.write`,
`ledger.prune`, `mutation.begin`/`fail`, `clock.next` — mirroring the `sql/`
folder scopes. Whole-store, transaction-scope operations (`setup`, `commit`,
`clear`, `close`) stay at the root. Layers that cannot nest flatten the same
taxonomy mechanically: `blob.read` → `blobRead` (napi/binding) → `blob_read`
(Rust).

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
