import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computeWindowsProductKey } from "./windows-product-key.ts";

const roots: string[] = [];
const bunBaseline = "bun-1.2.21:23f2df1f40d963e5b6104e1a565df992aab8968da5004f460617073843b8b8be";
const externalIdentity = "node-win-x64:1177b413;cloakbrowser:official-browser-hash";

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function write(root: string, path: string, contents: string): void {
  const target = join(root, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-product-key-"));
  roots.push(root);
  git(root, "init", "--quiet");
  write(root, ".github/workflows/client-compatibility.yml", "compatibility one\n");
  write(root, ".github/workflows/release-candidate.yml", "release one\n");
  write(root, "README.md", "readme one\n");
  write(root, "src/product.ts", "export const product = 1;\n");
  write(root, "version.test.ts", "test version one\n");
  write(root, "scripts/windows-in-app-update-acceptance.ps1", "acceptance one\n");
  write(root, "scripts/windows-installed-acceptance.ps1", "installed one\n");
  write(root, "scripts/windows-previous-upgrade-acceptance.ps1", "upgrade one\n");
  write(root, "scripts/windows-updater-https-fixture.mjs", "fixture one\n");
  write(root, "scripts/windows-updater-ui-probe.mjs", "probe one\n");
  git(root, "add", ".");
  return root;
}

function key(root: string, overrides: Partial<{
  version: string;
  toolchainIdentity: string;
  externalIdentity: string;
}> = {}): string {
  return computeWindowsProductKey({
    repoRoot: root,
    version: "0.1.0-beta.47",
    toolchainIdentity: bunBaseline,
    externalIdentity,
    ...overrides,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("Windows product key is deterministic and includes every unknown product file", () => {
  const root = repository();
  const initial = key(root);
  expect(key(root)).toBe(initial);

  write(root, "src/product.ts", "export const product = 2;\n");
  expect(key(root)).not.toBe(initial);
  write(root, "src/product.ts", "export const product = 1;\n");

  write(root, "new-unknown-file.txt", "new tracked input\n");
  git(root, "add", "new-unknown-file.txt");
  expect(key(root)).not.toBe(initial);
});

test("Windows product key includes version, toolchain, and external identities", () => {
  const root = repository();
  const initial = key(root);

  expect(key(root, { version: "0.1.0-beta.48" })).not.toBe(initial);
  expect(key(root, { toolchainIdentity: `${bunBaseline}-changed` })).not.toBe(initial);
  expect(key(root, { externalIdentity: `${externalIdentity}-changed` })).not.toBe(initial);
});

test("Windows product key ignores only tests and exact non-product paths", () => {
  const root = repository();
  const initial = key(root);

  write(root, ".github/workflows/client-compatibility.yml", "compatibility two\n");
  write(root, ".github/workflows/release-candidate.yml", "release two\n");
  write(root, "README.md", "readme two\n");
  write(root, "version.test.ts", "test version two\n");
  write(root, "scripts/windows-in-app-update-acceptance.ps1", "acceptance two\n");
  write(root, "scripts/windows-installed-acceptance.ps1", "installed two\n");
  write(root, "scripts/windows-previous-upgrade-acceptance.ps1", "upgrade two\n");
  write(root, "scripts/windows-updater-https-fixture.mjs", "fixture two\n");
  write(root, "scripts/windows-updater-ui-probe.mjs", "probe two\n");
  expect(key(root)).toBe(initial);

  write(root, "scripts/unrecognized-acceptance-helper.mjs", "unknown\n");
  git(root, "add", "scripts/unrecognized-acceptance-helper.mjs");
  expect(key(root)).not.toBe(initial);
});

test("Windows product key fails closed for Git errors and missing tracked files", () => {
  const root = repository();
  unlinkSync(join(root, "src", "product.ts"));
  expect(() => key(root)).toThrow("tracked product file");

  const notGit = mkdtempSync(join(tmpdir(), "aliasmode-product-key-no-git-"));
  roots.push(notGit);
  expect(() => key(notGit)).toThrow("git ls-files");
});
