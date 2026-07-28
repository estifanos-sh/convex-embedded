const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
const { createHash } = require("node:crypto") as typeof import("node:crypto");
const { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } =
  require("node:fs") as typeof import("node:fs");
const os = require("node:os") as typeof import("node:os");
const path = require("node:path") as typeof import("node:path");

type MobilePlatform = "android" | "ios";

/**
 * `IOS_TARGETS`, `ANDROID_NDK_VERSION`, and `CARGO_NDK_VERSION` mirror `iosTargetTriples`,
 * `androidNdkVersion`, and `cargoNdkVersion` in `config/build.ts` and must stay in sync. This
 * `eas-build-pre-install` hook runs as a bare-node CommonJS script before `node_modules` and the
 * ESM `config` package exist, so it cannot import them.
 */
const IOS_TARGETS = ["aarch64-apple-ios", "aarch64-apple-ios-sim", "x86_64-apple-ios"] as const;
const ANDROID_TARGETS = [
  "aarch64-linux-android",
  "armv7-linux-androideabi",
  "i686-linux-android",
  "x86_64-linux-android",
] as const;
const ANDROID_NDK_VERSION = "28.1.13356709";
const CARGO_NDK_VERSION = "3.5.4";
const RUSTUP_VERSION = "1.28.2";
const RUSTUP_INSTALLERS = {
  "aarch64-apple-darwin": "20ef5516c31b1ac2290084199ba77dbbcaa1406c45c1d978ca68558ef5964ef5",
  "x86_64-apple-darwin": "9c331076f62b4d0edeae63d9d1c9442d5fe39b37b05025ec8d41c5ed35486496",
  "x86_64-unknown-linux-gnu": "20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c",
} as const;

type RustupHost = keyof typeof RUSTUP_INSTALLERS;

const workspaceRoot = path.resolve(__dirname, "../../..");
const mobileScript = path.join(workspaceRoot, "packages/embedded/scripts/mobile.ts");
const requestedPlatform = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
const prepare = requestedPlatform === "eas" || process.argv.includes("--prepare");
const platform = readPlatform(requestedPlatform);
const environment = { ...process.env };

if (prepare) prepareToolchain(platform, environment);
run(process.execPath, [mobileScript, platform], environment);

function readPlatform(requested: string | undefined): MobilePlatform {
  const value = requested === "eas" ? process.env.EAS_BUILD_PLATFORM : requested;
  if (value === "android" || value === "ios") return value;
  if (requested === "eas") {
    throw new Error(
      'EAS_BUILD_PLATFORM must be set to "android" or "ios" for the EAS pre-install hook.',
    );
  }
  throw new Error('Native artifact build requires an "android", "ios", or "eas" argument.');
}

function prepareToolchain(platform: MobilePlatform, env: NodeJS.ProcessEnv): void {
  prepareRustup(env);

  const toolchainPath = path.join(workspaceRoot, "rust-toolchain.toml");
  const toolchain = readFileSync(toolchainPath, "utf8");
  const channel = matchValue(toolchain, /channel\s*=\s*"([^"]+)"/, "Rust channel");
  const components = matchValues(toolchain, /components\s*=\s*\[([^\]]+)\]/, "Rust components");
  const targets = platform === "ios" ? IOS_TARGETS : ANDROID_TARGETS;

  run(
    "rustup",
    [
      "toolchain",
      "install",
      channel,
      "--profile",
      "minimal",
      ...components.flatMap((value) => ["--component", value]),
    ],
    env,
  );
  run("rustup", ["target", "add", "--toolchain", channel, ...targets], env);

  if (platform === "android") prepareAndroid(channel, env);
}

function prepareRustup(env: NodeJS.ProcessEnv): void {
  const cargoHome = env.CARGO_HOME ?? path.join(os.homedir(), ".cargo");
  const rustupHome = env.RUSTUP_HOME ?? path.join(os.homedir(), ".rustup");
  const cargoBin = path.join(cargoHome, "bin");

  env.CARGO_HOME = cargoHome;
  env.RUSTUP_HOME = rustupHome;
  env.PATH = [cargoBin, env.PATH].filter(Boolean).join(path.delimiter);

  const installed = read("rustup", ["--version"], env);
  if (installed.trim()) return;

  const host = readRustupHost();
  const archiveRoot = `https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}`;
  const url = `${archiveRoot}/${host}/rustup-init`;
  const expectedSha256 = RUSTUP_INSTALLERS[host];
  const temporaryDirectory = dryRun
    ? path.join(os.tmpdir(), "convex-embedded-rustup")
    : mkdtempSync(path.join(os.tmpdir(), "convex-embedded-rustup-"));
  const installer = path.join(temporaryDirectory, "rustup-init");

  try {
    run(
      "curl",
      ["--fail", "--location", "--silent", "--show-error", url, "--output", installer],
      env,
    );
    verifySha256(installer, expectedSha256);
    if (!dryRun) chmodSync(installer, 0o755);
    run(
      installer,
      ["-y", "--profile", "minimal", "--default-toolchain", "none", "--no-modify-path"],
      env,
    );
  } finally {
    if (!dryRun) rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

function readRustupHost(): RustupHost {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "aarch64-apple-darwin";
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return "x86_64-apple-darwin";
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return "x86_64-unknown-linux-gnu";
  }
  throw new Error(
    `Rustup ${RUSTUP_VERSION} bootstrap does not support ${process.platform}/${process.arch}. ` +
      "Supported hosts are macOS arm64, macOS x64, and Linux x64.",
  );
}

function verifySha256(file: string, expected: string): void {
  console.log(`+ verify-sha256 ${expected} ${quote(file)}`);
  if (dryRun) return;

  const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (actual !== expected) {
    throw new Error(`Rustup installer SHA-256 mismatch: expected ${expected}, received ${actual}.`);
  }
}

function prepareAndroid(channel: string, env: NodeJS.ProcessEnv): void {
  const installedCargoNdk = read("cargo", ["ndk", "--version"], env);
  if (!installedCargoNdk.includes(CARGO_NDK_VERSION)) {
    run(
      "cargo",
      [
        `+${channel}`,
        "install",
        "cargo-ndk",
        "--version",
        CARGO_NDK_VERSION,
        "--locked",
        "--force",
      ],
      env,
    );
  }

  const sdkRoot = env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT;
  const configuredNdk = env.ANDROID_NDK_HOME ?? env.ANDROID_NDK_ROOT;
  const pinnedNdk = sdkRoot ? path.join(sdkRoot, "ndk", ANDROID_NDK_VERSION) : undefined;
  const ndkPath = [configuredNdk, pinnedNdk].find(isPinnedNdk);
  if (ndkPath) {
    env.ANDROID_NDK_HOME = ndkPath;
    env.ANDROID_NDK_ROOT = ndkPath;
    return;
  }
  if (!sdkRoot) {
    if (dryRun) {
      console.log(`+ sdkmanager ${quote(`ndk;${ANDROID_NDK_VERSION}`)}`);
      return;
    }
    throw new Error(
      "ANDROID_HOME or ANDROID_SDK_ROOT must point to the Android SDK before building native artifacts.",
    );
  }

  const cmdlineTools = path.join(sdkRoot, "cmdline-tools");
  const sdkBinDirs = existsSync(cmdlineTools)
    ? readdirSync(cmdlineTools)
        .map((entry) => path.join(cmdlineTools, entry, "bin"))
        .filter((dir) => existsSync(dir))
    : [];
  env.PATH = [...sdkBinDirs, env.PATH].filter(Boolean).join(path.delimiter);

  run("sdkmanager", ["--install", `ndk;${ANDROID_NDK_VERSION}`], env);
  if (!dryRun && !isPinnedNdk(pinnedNdk)) {
    throw new Error(`Android NDK ${ANDROID_NDK_VERSION} was not installed at ${pinnedNdk}.`);
  }
  env.ANDROID_NDK_HOME = pinnedNdk;
  env.ANDROID_NDK_ROOT = pinnedNdk;
}

function isPinnedNdk(candidate: string | undefined): candidate is string {
  if (!candidate) return false;
  const properties = path.join(candidate, "source.properties");
  return (
    existsSync(properties) &&
    readFileSync(properties, "utf8").includes(`Pkg.Revision = ${ANDROID_NDK_VERSION}`)
  );
}

function matchValue(source: string, pattern: RegExp, label: string): string {
  const match = source.match(pattern)?.[1];
  if (!match) throw new Error(`${label} is missing from rust-toolchain.toml.`);
  return match;
}

function matchValues(source: string, pattern: RegExp, label: string): string[] {
  const list = matchValue(source, pattern, label);
  const values = [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  if (values.length === 0) throw new Error(`${label} are missing from rust-toolchain.toml.`);
  return values;
}

function read(command: string, args: string[], env: NodeJS.ProcessEnv): string {
  if (dryRun) return "";
  try {
    return execFileSync(command, args, {
      cwd: workspaceRoot,
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  console.log(`+ ${[command, ...args].map(quote).join(" ")}`);
  if (dryRun) return;
  try {
    execFileSync(command, args, { cwd: workspaceRoot, env, stdio: "inherit" });
  } catch (cause: unknown) {
    throw new Error(`Native artifact command failed: ${command} ${args.join(" ")}`, { cause });
  }
}

function quote(value: string): string {
  return /^[A-Za-z0-9_+./:@=-]+$/.test(value) ? value : JSON.stringify(value);
}
