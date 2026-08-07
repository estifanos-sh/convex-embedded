# Convex Embedded Expo demo

This Expo Router app exercises the package-owned iOS and Android storage binding. Queries and
mutations run against the embedded database on the device, remain available offline, and replicate
to the configured Convex deployment.

The app requires an Expo development build or a release build. Expo Go cannot load the custom
`ConvexEmbeddedNative` module.

From the repository root, install dependencies, build the artifact for your platform, and typecheck:

```sh
vp install
vp run @estifanos-sh/convex-embedded-demo-expo#build:package
vp run @estifanos-sh/convex-embedded-demo-expo#native:ios
# or: vp run @estifanos-sh/convex-embedded-demo-expo#native:android
vp run @estifanos-sh/convex-embedded-demo-expo#typecheck
```

Metro and the browser Vite demo share `VITE_CONVEX_URL` from the repository root `.env.local`.
Metro maps that client-safe URL to `EXPO_PUBLIC_CONVEX_URL` at bundle time, so do not create a
second env file under `demos/expo`. CI and EAS builds should set `VITE_CONVEX_URL` in their build
environment because the uncommitted root env file is not present in remote builds. Metro fails with
an actionable error when the canonical URL is missing rather than silently building a local-only
demo.

Build and open a native development app with one of these commands:

```sh
vp run @estifanos-sh/convex-embedded-demo-expo#ios
vp run @estifanos-sh/convex-embedded-demo-expo#android
```

The demo `ios` and `android` scripts first build the package's TypeScript exports, then install the
pinned Rust targets and native tooling, rebuild the matching native artifact, and invoke
`expo run`. The Android setup discovers `ANDROID_HOME`/`ANDROID_SDK_ROOT`, the default Android Studio
SDK, or Homebrew's command-line tools and installs NDK `28.1.13356709`. On macOS, a minimal local
toolchain can be installed without a privileged JDK package:

```sh
brew install openjdk@17
brew install --cask android-commandlinetools
JAVA_HOME="$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home" sdkmanager --licenses
```

Review and accept Google's SDK license interactively; the build never accepts it on your behalf.
The preparation hook then installs the pinned `cargo-ndk`, Rust targets, and NDK revision. Explicit
environment variables still take precedence for custom SDK installations.

After the native app exists, Metro can be started separately with:

```sh
vp run @estifanos-sh/convex-embedded-demo-expo#start
```

Restart Metro whenever the Convex schema or a device function changes. The Metro adapter regenerates
the embedded module registry and the shared `convex/_generated/embedded.ts` contract during
configuration. Vite writes that same contract, which Convex codegen never replaces.

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
