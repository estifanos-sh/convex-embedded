# Framework dependency evidence

Fallow's dependency analysis follows source imports. The Expo demo also has
native-module, framework-peer, and app-configuration edges that have no source
import in this repository. The exact `ignoreDependencies` entries in
`.fallowrc.json` are limited to those edges:

- `expo-crypto` is the demo's direct installation of the embedded package's
  optional Expo peer. The package imports it from `src/expo/crypto.ts`; keeping
  the demo declaration proves the consumer contract without making every
  embedded installation require Expo.
- `expo-dev-client` is an Expo config plugin in `demos/expo/app.json` and is
  required by the demo's `expo start --dev-client` and development native
  builds. It remains a dependency, rather than a dev dependency, because the
  app configuration names its plugin for every build profile.
- `react-native-web` is Expo Router's optional peer used by the demo's web
  export/static rendering path.
- `react-native-webview` is selected by Expo's DOM-component runtime for the
  demo's `"use dom"` editor. Expo resolves it indirectly at runtime rather
  than through an application import.

Do not add ordinary application packages here. A new entry needs a comparable
framework-owned resolution path and a reviewable reason in this document.
