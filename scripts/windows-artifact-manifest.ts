import { createHash } from "node:crypto";
import { createReadStream, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export const WINDOWS_ARTIFACT_MANIFEST_NAME = "artifact-manifest.json";

export interface WindowsArtifactManifestInput {
  role: string;
  version: string;
  productKey: string;
  source: string;
  files: string[];
}

export interface WindowsArtifactManifest {
  schema: 1;
  role: string;
  version: string;
  productKey: string;
  source: string;
  files: Array<{ name: string; bytes: number; sha256: string }>;
}

function validatedInput(input: WindowsArtifactManifestInput): WindowsArtifactManifestInput {
  if (!input.role.trim()) throw new Error("artifact role must not be blank");
  if (!input.version.trim()) throw new Error("artifact version must not be blank");
  if (!/^[a-f0-9]{64}$/.test(input.productKey)) throw new Error("artifact product key must be a lowercase SHA-256");
  if (!input.source.trim()) throw new Error("artifact source must not be blank");
  if (!input.files.length) throw new Error("artifact manifest must declare files");

  const names = new Set<string>();
  for (const name of input.files) {
    if (
      !name || name === WINDOWS_ARTIFACT_MANIFEST_NAME || basename(name) !== name ||
      name.includes("/") || name.includes("\\")
    ) {
      throw new Error(`artifact name must be a safe file name: ${name}`);
    }
    if (names.has(name)) throw new Error(`artifact name is duplicated: ${name}`);
    names.add(name);
  }
  return input;
}

function assertExactFiles(directory: string, expectedNames: string[], allowManifest: boolean): void {
  const expected = new Set(expectedNames);
  if (allowManifest) expected.add(WINDOWS_ARTIFACT_MANIFEST_NAME);
  const entries = readdirSync(directory, { withFileTypes: true });
  const actual = entries.map((entry) => entry.name).sort();
  if (entries.some((entry) => !entry.isFile()) || actual.length !== expected.size || actual.some((name) => !expected.has(name))) {
    throw new Error("artifact directory must contain exactly the declared files");
  }
}

async function fileIdentity(path: string): Promise<{ bytes: number; sha256: string }> {
  const before = statSync(path);
  if (!before.isFile()) throw new Error(`artifact is not a regular file: ${path}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const after = statSync(path);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new Error(`artifact changed while it was hashed: ${path}`);
  }
  return { bytes: before.size, sha256: hash.digest("hex") };
}

async function expectedManifest(
  directory: string,
  input: WindowsArtifactManifestInput,
  allowManifest: boolean,
): Promise<WindowsArtifactManifest> {
  validatedInput(input);
  const names = [...input.files].sort();
  assertExactFiles(directory, names, allowManifest);
  const identities: WindowsArtifactManifest["files"] = [];
  for (const name of names) {
    identities.push({ name, ...await fileIdentity(join(directory, name)) });
  }
  assertExactFiles(directory, names, allowManifest);
  return {
    schema: 1,
    role: input.role,
    version: input.version,
    productKey: input.productKey,
    source: input.source,
    files: identities,
  };
}

function canonicalText(manifest: WindowsArtifactManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export async function createWindowsArtifactManifest(
  directory: string,
  input: WindowsArtifactManifestInput,
): Promise<WindowsArtifactManifest> {
  const root = resolve(directory);
  const manifest = await expectedManifest(
    root,
    input,
    readdirSync(root).includes(WINDOWS_ARTIFACT_MANIFEST_NAME),
  );
  writeFileSync(join(root, WINDOWS_ARTIFACT_MANIFEST_NAME), canonicalText(manifest), "utf8");
  return manifest;
}

export async function verifyWindowsArtifactManifest(
  directory: string,
  input: WindowsArtifactManifestInput,
): Promise<WindowsArtifactManifest> {
  const root = resolve(directory);
  const manifestPath = join(root, WINDOWS_ARTIFACT_MANIFEST_NAME);
  const text = readFileSync(manifestPath, "utf8");
  let parsed: WindowsArtifactManifest;
  try {
    parsed = JSON.parse(text) as WindowsArtifactManifest;
  } catch {
    throw new Error("artifact manifest is not valid JSON");
  }
  if (text !== canonicalText(parsed)) throw new Error("artifact manifest is not canonical");
  const expected = await expectedManifest(root, input, true);
  if (text !== canonicalText(expected)) throw new Error("artifact manifest does not match its files and identity");
  return expected;
}

function cliInput(args: string[]): { command: "create" | "verify"; directory: string; input: WindowsArtifactManifestInput } {
  const [command, directory, ...rest] = args;
  if ((command !== "create" && command !== "verify") || !directory) throw new Error("invalid artifact manifest command");
  const values = new Map<string, string>();
  const files: string[] = [];
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag || !value) throw new Error("artifact manifest arguments must be flag-value pairs");
    if (flag === "--file") {
      files.push(value);
    } else if (["--role", "--version", "--product-key", "--source"].includes(flag)) {
      if (values.has(flag)) throw new Error(`duplicate argument: ${flag}`);
      values.set(flag, value);
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  const role = values.get("--role");
  const version = values.get("--version");
  const productKey = values.get("--product-key");
  const source = values.get("--source");
  if (!role || !version || !productKey || !source || !files.length) {
    throw new Error("usage: bun scripts/windows-artifact-manifest.ts <create|verify> <directory> --role <role> --source <source> --version <version> --product-key <key> --file <name> [...]");
  }
  return { command, directory, input: { role, version, productKey, source, files } };
}

if (import.meta.main) {
  try {
    const { command, directory, input } = cliInput(process.argv.slice(2));
    const manifest = command === "create"
      ? await createWindowsArtifactManifest(directory, input)
      : await verifyWindowsArtifactManifest(directory, input);
    console.log(JSON.stringify(manifest));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
