/** Stages the macOS arm64 bundle inputs: sidecar, agent helper, AliasMode Firefox and the agent runtime. */
import { createHash } from "node:crypto";
import { closeSync, cpSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { sha256File } from "../browser-install.ts";
import { FIREFOX_RUNTIME_VERSION, firefoxBuildForHost, installFirefox } from "../firefox-install.ts";
import { installSourceNode } from "../source-runtime.ts";
import { ALIASMODE_VERSION } from "../version.ts";
import { compileAgent, compileSidecar, stageAgentRuntime } from "./prepare-windows-bundle.ts";

const BUN_TARGET = "bun-darwin-arm64";
const RUST_TARGET = "aarch64-apple-darwin";

// The same CPython and Playwright versions as the Windows bundle, in their macOS arm64 builds.
const PYTHON_ARCHIVE = {
  url: "https://github.com/astral-sh/python-build-standalone/releases/download/20250918/cpython-3.13.7%2B20250918-aarch64-apple-darwin-install_only_stripped.tar.gz",
  sha256: "10f26ea5fc7c4d9c012faf372898a801f34b8fd7730c677576263224d56835fe",
};
const PYTHON_WHEELS = [
  {
    url: "https://files.pythonhosted.org/packages/e0/40/59d34a756e02f8c670f0fee987d46f7ee53d05447d43cd114ca015cb168c/playwright-1.58.0-py3-none-macosx_11_0_arm64.whl",
    sha256: "70c763694739d28df71ed578b9c8202bb83e8fe8fb9268c04dd13afe36301f71",
  },
  {
    url: "https://files.pythonhosted.org/packages/f3/57/0db4940cd7bb461365ca8d6fd53e68254c9dbbcc2b452e69d0d41f10a85e/greenlet-3.1.1-cp313-cp313-macosx_11_0_universal2.whl",
    sha256: "05175c27cb459dcfc05d026c4232f9de8913ed006d42713cb8a5137bd49375f1",
  },
  {
    url: "https://files.pythonhosted.org/packages/9b/4d/b9add7c84060d4c1906abe9a7e5359f2a60f7a9a4f67268b2766673427d8/pyee-13.0.0-py3-none-any.whl",
    sha256: "48195a3cddb3b1515ce0695ed76036b5ccc2ef3a9f963ff9f77aec0139845498",
  },
  {
    url: "https://files.pythonhosted.org/packages/18/67/36e9267722cc04a6b9f15c7f3441c2363321a3ea07da7ae0c0707beb2a9c/typing_extensions-4.15.0-py3-none-any.whl",
    sha256: "f0fa19c6845758ab08074a0cfa8b7aecb71c999ca73d62883bc25cc018c4e548",
  },
];

// Thin and universal Mach-O files, as the first four bytes on disk.
const MACH_O_MAGIC = new Set(["cffaedfe", "cefaedfe", "cafebabe", "cafebabf"]);

function isMachO(path: string): boolean {
  const header = Buffer.alloc(4);
  const file = openSync(path, "r");
  try {
    return readSync(file, header, 0, 4, 0) === 4 && MACH_O_MAGIC.has(header.toString("hex"));
  } finally {
    closeSync(file);
  }
}

/**
 * Signs the programs that Tauri does not sign, because they are bundle resources: each Mach-O file,
 * then each nested bundle, innermost first. Apple notarization needs the hardened runtime and a
 * timestamp on all of them. Without APPLE_SIGNING_IDENTITY the signature is ad-hoc.
 */
export async function signResourcePrograms(tauri: string, roots: string[], execute = run): Promise<void> {
  const identity = process.env.APPLE_SIGNING_IDENTITY || "-";
  const entries = roots.flatMap((root) => readdirSync(root, { recursive: true, withFileTypes: true }))
    .map((entry) => ({ entry, path: join(entry.parentPath, entry.name) }));
  const innermostFirst = (paths: string[]) => paths.sort((a, b) => b.split(sep).length - a.split(sep).length);
  const programs = entries.filter(({ entry, path }) => entry.isFile() && isMachO(path)).map(({ path }) => path);
  const bundles = entries.filter(({ entry }) => entry.isDirectory() && /\.(app|framework)$/.test(entry.name)).map(({ path }) => path);
  for (const path of [...innermostFirst(programs), ...innermostFirst(bundles)]) {
    await execute([
      "codesign", "--force", "--sign", identity, "--options", "runtime",
      "--entitlements", join(tauri, "macos", "entitlements.plist"),
      ...(identity === "-" ? [] : ["--timestamp"]), path,
    ]);
  }
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`${command[0]} exited with code ${child.exitCode}`);
}

async function downloadPinned(url: string, sha256: string, output: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed: ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error(`SHA-256 mismatch: ${url}`);
  writeFileSync(output, bytes);
}

/** Stages CPython and the Playwright wheels for Python scripts; system tools keep file modes. */
async function installPython(staging: string, playwrightRoot: string): Promise<void> {
  const archive = join(staging, "python.tar.gz");
  await downloadPinned(PYTHON_ARCHIVE.url, PYTHON_ARCHIVE.sha256, archive);
  await run(["tar", "-xzf", archive, "-C", playwrightRoot]);
  const python = join(playwrightRoot, "python");
  // The archive's convenience symlinks are not needed, and the bundler copies plain files only.
  await run(["find", python, "-type", "l", "-delete"]);
  const sitePackages = join(python, "lib", "python3.13", "site-packages");
  for (const [index, wheel] of PYTHON_WHEELS.entries()) {
    const file = join(staging, `wheel-${index}.whl`);
    await downloadPinned(wheel.url, wheel.sha256, file);
    await run(["unzip", "-q", "-o", file, "-d", sitePackages]);
  }
  for (const required of [join(python, "bin", "python3.13"), join(sitePackages, "playwright", "driver", "node")]) {
    if (!statSync(required, { throwIfNoEntry: false })?.isFile()) throw new Error("Python script runtime is incomplete");
  }
}

export async function prepareMacosBundle(cwd = process.cwd()): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("macOS bundle preparation requires Apple Silicon macOS");
  }
  const tauri = join(resolve(cwd), "src-tauri");
  const staging = join(tauri, "target", "desktop-staging");
  const firefoxRoot = join(tauri, "resources", "firefox");
  const playwrightRoot = join(tauri, "resources", "playwright");
  for (const path of [staging, firefoxRoot, playwrightRoot]) rmSync(path, { recursive: true, force: true });
  for (const path of [staging, join(tauri, "generated"), join(tauri, "binaries"), join(playwrightRoot, "node")]) {
    mkdirSync(path, { recursive: true });
  }

  await compileSidecar(cwd, join(tauri, "binaries", `aliasmode-sidecar-${RUST_TARGET}`), BUN_TARGET);
  await compileAgent(cwd, join(tauri, "binaries", `aliasmode-mcp-${RUST_TARGET}`), BUN_TARGET);

  const build = firefoxBuildForHost();
  const firefox = await installFirefox({ cwd: staging, writeEnv: false });
  renameSync(resolve(firefox.path, ...build.executablePath.split("/").map(() => "..")), firefoxRoot);

  cpSync(await installSourceNode(staging), join(playwrightRoot, "node", "node"));
  await installPython(staging, playwrightRoot);
  stageAgentRuntime(cwd, playwrightRoot);

  // The published engine bundle has no resource seal, so macOS reports its signature as broken.
  // Sign after the pinned hashes passed; the packaged hash below is the signed executable.
  await signResourcePrograms(tauri, [firefoxRoot, playwrightRoot]);
  const firefoxSha256 = await sha256File(join(firefoxRoot, build.executablePath));

  const metadata = {
    firefox: {
      executable: build.executablePath,
      sha256: firefoxSha256,
      version: FIREFOX_RUNTIME_VERSION,
      archiveSha256: build.archiveSha256,
    },
  };
  writeFileSync(join(tauri, "generated", "browser.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  writeFileSync(join(tauri, "generated", "VERSION.txt"), `${ALIASMODE_VERSION}\n`, "utf8");
}

if (import.meta.main) {
  try {
    await prepareMacosBundle();
    console.log("prepared AliasMode macOS bundle");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
