# Embedded metal tests

The metal suite drives real browser-device sync through the hosted/dev Convex
deployment configured for this workspace. It covers offline, reconnect,
restart, and CAS/rev conflict flows from browser storage, and it is intentionally
separate from the node `remote` suite.

Metal uses the same backend URL as the demo: `VITE_CONVEX_URL` from the repo
root `.env.local`, falling back to `CONVEX_URL`. It does not read
`CONVEX_EMBEDDED_REMOTE_URL`, and the dev server is not started by these
commands.

Correctness smoke:

```sh
vp run @estifanos-sh/convex-embedded#test:metal
```

Small hosted scale smoke:

```sh
vp run @estifanos-sh/convex-embedded#bench:metal:scale -- --clients 2 --revs 1 --duration-ms 100 --timeout-ms 90000 --skip-rev-list --out tests/bench/.out/metal-scale-smoke.json
```

Default hosted scale matrix:

```sh
vp run @estifanos-sh/convex-embedded#bench:metal:reconnect
vp run @estifanos-sh/convex-embedded#bench:metal:scale
vp run @estifanos-sh/convex-embedded#bench:metal:scale:matrix
vp run @estifanos-sh/convex-embedded#bench:metal:scale:manual
```

`bench:metal:scale:matrix` runs `5`, `10`, and `20` clients with `10,000` revs
and full `rev.list` coverage. `bench:metal:scale:stress` runs `5`, `10`, `20`,
`30`, and `50` clients with `100,000` revs and passes `--skip-rev-list` to
isolate high-volume writes, hosted rev creation, and fanout from full-history
array-return cost.
