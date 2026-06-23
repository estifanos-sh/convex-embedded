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

## Lexicon — minimal verb/noun dictionary for @convex-dev/embedded

Authored code uses one small vocabulary, shared identically across the Rust and
TypeScript layers, in `noun.[noun.]verb` shape. Keep it small on purpose: reach
for a new noun (or a nested noun) before a new verb. Convex API names, platform
API names, generated files, and tool-required config names keep their native
spellings.

### Storage-shaped verbs (the whole set)

| Verb                | Meaning                                                        | Absorbs — do not use                                                                                                       |
| ------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `read`              | Read one value, a range/page, or a count                       | `get`, `scan`, `list`, `gather`, `project`, `count`, `lookup`, `find`, local `fetch`                                       |
| `write`             | Persist a value or bytes — new, whole, partial, or lease state | `store`, `set`, `insert`, `replace`, `patch`, `stage`, `import`, `put`, `persist`, `claim`, `renew`, `release`, `complete` |
| `delete`            | Remove a durable record                                        | `drop`, `prune`, durable `remove`, `deleteAll`                                                                             |
| `clear`             | Reset or empty a whole collection/scope                        | `deleteAll`, `truncate`                                                                                                    |
| `encode` / `decode` | Bytes/transport codec                                          | `serialize`, `deserialize`                                                                                                 |
| `is` / `has`        | Boolean predicate                                              | `check`, `should`, `due`                                                                                                   |
| `push` / `pull`     | Remote wire transfer (the only replication verbs)              | `replicate`, `sync`, `apply`, `ack`, `settle`                                                                              |

Whole-store / transaction-scope roots stay bare verbs: `open`, `setup`,
`commit`, `close`. Durable-record lifecycle transitions stay named —
`complete` / `fail` / `cancel` (the terminal states a scheduled job, upload, or
mutation moves through) — a small fixed set, like the transaction roots above
(this is the one carve-out from `complete` being absorbed by `write`).

### Nouns (namespaces)

`doc`, `key`, `blob`, `file`, `id`, `rev`, `ledger`, `mutation`, `clock`,
`schedule`, `upload`, `remote`. Push specificity into nested nouns rather than
new verbs: `rev.frontier.read`, `remote.cursor.write`, `upload.lease.write`. The
versioned-document concept is `rev` (revision) everywhere — never `branch` or
`ref` (`ref` is a Rust keyword and collides with Convex's `FunctionReference`).

### Grammar and layers

`noun.[noun.]verb`, identical per layer and flattened mechanically across the
FFI: `rev.read` (TS) → `revRead` (napi/binding) → `rev_read` / `rev::read`
(Rust).

Three surfaces keep three vocabularies — do not force one into another:

- Storage-shaped layer (Rust store, napi/wasm binding, TS `storage/`): the verb
  table above and nothing else.
- Public client and server-wrapper APIs (app-authorized `components.embedded.rev.*`,
  `embedded.storage.rebuild`): product verbs, like `@convex-dev/stream`'s
  `append` / `finish` / `cancel`.
- Convex-facing code (`runtime/`, `component/`): Convex's native `insert`,
  `patch`, `replace`, `delete`, `get`, `query`, `collect`.

Authored file and folder names under package source, tests, and scripts are one
lowercase word; use folders for broad, meaningful scopes instead of kebab-case,
camelCase, snake_case, or folder-per-test segmentation.

## Layout

Generated and scratch paths stay out of source control (see `.gitignore`): build
outputs live in `dist/` (bundles) and `target/` (Rust), and bench artifacts write
to `packages/embedded/tests/bench/.out/`, never the package root. Root tool config
is `.fallowrc.json` (dead-code baseline) and `rust-toolchain.toml`. Test harness
code — Playwright page installers, bench orchestrators, and option/env readers —
lives in `packages/embedded/tests/browser/harness/` and
`packages/embedded/tests/bench/harness/`; the per-project vitest definitions sit
under `packages/embedded/vite/`, so `vite.config.ts` is imports plus one
`defineConfig` assembly and nothing else.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
