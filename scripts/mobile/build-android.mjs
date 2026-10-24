import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const mobile = join(root, "apps/mobile");
const env = { ...process.env };
const windows = process.platform === "win32";
const sdk = [
	env.ANDROID_HOME,
	env.ANDROID_SDK_ROOT,
	join(root, ".cache/android/sdk"),
	join(homedir(), "Android/Sdk"),
	join(homedir(), "Library/Android/sdk"),
	env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Android/Sdk"),
].find((path) => path && existsSync(join(path, "platforms/android-36/android.jar")));
if (!sdk)
	throw new Error(
		"Android SDK 36 is required. Set ANDROID_HOME to your SDK (platforms;android-36 and build-tools;36.0.0).",
	);
env.ANDROID_HOME = sdk;
if (!env.JAVA_HOME && existsSync(join(root, ".cache/android/java/bin/javac")))
	env.JAVA_HOME = join(root, ".cache/android/java");
if (env.JAVA_HOME) env.PATH = `${join(env.JAVA_HOME, "bin")}${delimiter}${env.PATH ?? ""}`;
const java = env.JAVA_HOME ? join(env.JAVA_HOME, windows ? "bin/java.exe" : "bin/java") : "java";
const javaCheck = spawnSync(java, ["-version"], { env, encoding: "utf8" });
const javaMajor = Number(/version "(\d+)/.exec(javaCheck.stderr ?? "")?.[1]);
if (!javaCheck.error && javaCheck.status === 0 && javaMajor >= 21) {
} else throw new Error("JDK 21 or newer is required. Set JAVA_HOME to a JDK installation.");
env.GRADLE_USER_HOME ||= join(root, ".cache/android/gradle");
function run(command, args, cwd) {
	const result = spawnSync(command, args, {
		cwd,
		env,
		stdio: "inherit",
		shell: windows && /\.(cmd|bat)$/i.test(command),
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status || 1);
}
console.log("Building Gentle Dot Mobile…");
run(windows ? "pnpm.cmd" : "pnpm", ["--filter", "@gentle-dot/mobile", "build"], root);
run(
	windows ? "pnpm.cmd" : "pnpm",
	["--filter", "@gentle-dot/mobile", "exec", "cap", "sync", "android"],
	root,
);
const args = ["--no-daemon", "--max-workers=2", ":app:assembleDebug"];
if (process.argv.includes("--lint")) args.push(":app:lintDebug");
run(windows ? "gradlew.bat" : "./gradlew", args, join(mobile, "android"));
const builtApk = join(mobile, "android/app/build/outputs/apk/debug/app-debug.apk");
const buildTools = join(sdk, "build-tools/36.0.0");
run(
	join(buildTools, windows ? "apksigner.bat" : "apksigner"),
	["verify", "--verbose", "--print-certs", builtApk],
	root,
);
run(join(buildTools, windows ? "zipalign.exe" : "zipalign"), ["-c", "-P", "16", "4", builtApk], root);
const output = join(root, "build/android");
mkdirSync(output, { recursive: true });
const apk = join(output, "gentle-dot-debug.apk");
const pending = `${apk}.pending`;
copyFileSync(builtApk, pending);
const digest = createHash("sha256").update(readFileSync(pending)).digest("hex");
// A phone downloading the previous build can finish while the new APK is published.
renameSync(pending, apk);
writeFileSync(`${apk}.sha256.pending`, `${digest}  gentle-dot-debug.apk\n`);
renameSync(`${apk}.sha256.pending`, `${apk}.sha256`);
console.log(`Installable debug APK: ${apk}`);
console.log(`SHA-256: ${digest}`);
