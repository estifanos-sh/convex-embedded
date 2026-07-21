# Convex Embedded Expo demo

This Expo Router app exercises the package-owned iOS and Android storage binding. It is local-only:
queries and mutations run against the embedded database on the device, and native remote replication
is not enabled yet.

The app requires an Expo development build or a release build. Expo Go cannot load the custom
`ConvexEmbeddedNative` module.

From the repository root, install dependencies, build the artifact for your platform, and typecheck:

```sh
vp install
vp run @convex-dev/embedded-demo-expo#build:package
vp run @convex-dev/embedded-demo-expo#native:ios
# or: vp run @convex-dev/embedded-demo-expo#native:android
vp run @convex-dev/embedded-demo-expo#typecheck
```

Build and open a native development app with one of these commands:

```sh
vp run @convex-dev/embedded-demo-expo#ios
vp run @convex-dev/embedded-demo-expo#android
```

The demo `ios` and `android` scripts first build the package's TypeScript exports, then install the
pinned Rust targets and native tooling, rebuild the matching native artifact, and invoke
`expo run`. Android additionally requires `ANDROID_HOME` or `ANDROID_SDK_ROOT`; the script installs
and selects NDK `28.1.13356709`.

After the native app exists, Metro can be started separately with:

```sh
vp run @convex-dev/embedded-demo-expo#start
```

Restart Metro whenever the Convex schema or a device function changes. The Metro adapter regenerates
the embedded module registry and placement contract during configuration.

EAS development and store builds use `eas.json`. Run EAS from this directory so it picks up the demo
configuration. A checkout is intentionally not linked to any maintainer's Expo account, so sign in
and initialize your own EAS project once before the first build:

```sh
pnpm dlx eas-cli@latest login
pnpm dlx eas-cli@latest init
pnpm dlx eas-cli@latest build --profile development --platform ios
pnpm dlx eas-cli@latest build --profile production --platform all
```

EAS runs the platform-selective native artifact preparation through `eas-build-pre-install`, before
dependency installation and native prebuild. After dependencies and generated native projects are
ready, `eas-build-post-install` builds the package's TypeScript exports for Metro. The native hook
requires `EAS_BUILD_PLATFORM` to be `ios` or `android` and fails clearly for any other value. Its
command plan can be inspected without changing the toolchain:

```sh
EAS_BUILD_PLATFORM=ios pnpm run native:dry-run
```
