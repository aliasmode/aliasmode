import { createHash, type Hash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const NON_PRODUCT_PATHS = new Set([
  ".github/workflows/client-compatibility.yml",
  ".github/workflows/release-candidate.yml",
  ".gitignore",
  "LICENSE",
  "README.md",
  "scripts/windows-in-app-update-acceptance.ps1",
  "scripts/windows-installed-acceptance.ps1",
  "scripts/windows-previous-upgrade-acceptance.ps1",
  "scripts/windows-updater-https-fixture.mjs",
  "scripts/windows-updater-ui-probe.mjs",
]);

export interface WindowsProductKeyOptions {
  repoRoot: string;
  version: string;
  toolchainIdentity: string;
  externalIdentity: string;
}

function requireIdentity(name: string, value: string): string {
  if (!value.trim()) throw new Error(`${name} must not be blank`);
  return value;
}

function isTest(path: string): boolean {
  return /(?:^|\/)__tests__(?:\/|$)/.test(path) || /\.(?:test|spec)\.[^/]+$/.test(path);
}

function trackedFiles(repoRoot: string): string[] {
  const result = Bun.spawnSync(["git", "-C", repoRoot, "ls-files", "--cached", "-z"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`);
  }

  let output: string;
  try {
    output = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  } catch {
    throw new Error("git ls-files returned a non-UTF-8 path");
  }
  if (output && !output.endsWith("\0")) throw new Error("git ls-files returned malformed output");

  const files = output.split("\0").filter(Boolean).sort();
  if (new Set(files).size !== files.length) throw new Error("git ls-files returned a duplicate path");
  return files.filter((path) => !isTest(path) && !NON_PRODUCT_PATHS.has(path));
}

function addPart(hash: Hash, value: string | Uint8Array): void {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length).update(bytes);
}

export function computeWindowsProductKey(options: WindowsProductKeyOptions): string {
  const repoRoot = resolve(options.repoRoot);
  const hash = createHash("sha256");
  addPart(hash, "aliasmode-windows-product-key-v1");
  addPart(hash, requireIdentity("version", options.version));
  addPart(hash, requireIdentity("toolchain identity", options.toolchainIdentity));
  addPart(hash, requireIdentity("external identity", options.externalIdentity));

  const files = trackedFiles(repoRoot);
  if (!files.length) throw new Error("git ls-files returned no tracked product files");
  for (const path of files) {
    if (
      isAbsolute(path) || path.includes("\\") ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`git ls-files returned an unsafe path: ${path}`);
    }
    const fullPath = resolve(repoRoot, ...path.split("/"));
    let contents: Buffer;
    try {
      if (!lstatSync(fullPath).isFile()) throw new Error("not a regular file");
      contents = readFileSync(fullPath);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`could not read tracked product file ${path}: ${detail}`);
    }
    addPart(hash, path);
    addPart(hash, contents);
  }
  return hash.digest("hex");
}

function cliOptions(args: string[]): WindowsProductKeyOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !value || !["--repo-root", "--version", "--toolchain", "--external"].includes(flag)) {
      throw new Error("usage: bun scripts/windows-product-key.ts --version <version> --toolchain <identity> --external <identity> [--repo-root <path>]");
    }
    if (values.has(flag)) throw new Error(`duplicate argument: ${flag}`);
    values.set(flag, value);
  }
  const version = values.get("--version");
  const toolchainIdentity = values.get("--toolchain");
  const externalIdentity = values.get("--external");
  if (!version || !toolchainIdentity || !externalIdentity) {
    throw new Error("usage: bun scripts/windows-product-key.ts --version <version> --toolchain <identity> --external <identity> [--repo-root <path>]");
  }
  return {
    repoRoot: values.get("--repo-root") ?? process.cwd(),
    version,
    toolchainIdentity,
    externalIdentity,
  };
}

if (import.meta.main) {
  try {
    console.log(computeWindowsProductKey(cliOptions(process.argv.slice(2))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
