import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WINDOWS_ARTIFACT_MANIFEST_NAME,
  createWindowsArtifactManifest,
  verifyWindowsArtifactManifest,
  type WindowsArtifactManifestInput,
} from "./windows-artifact-manifest.ts";

const roots: string[] = [];
const productKey = "a".repeat(64);

function fixture(): { root: string; input: WindowsArtifactManifestInput } {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-artifact-manifest-"));
  roots.push(root);
  writeFileSync(join(root, "AliasMode_0.1.0-beta.47_x64-offline-setup.exe"), "MZ-full-installer");
  writeFileSync(join(root, "AliasMode_0.1.0-beta.47_x64-setup.exe"), "MZ-slim-installer");
  return {
    root,
    input: {
      role: "windows-candidate",
      version: "0.1.0-beta.47",
      productKey,
      source: "git-tree:0123456789abcdef",
      files: [
        "AliasMode_0.1.0-beta.47_x64-setup.exe",
        "AliasMode_0.1.0-beta.47_x64-offline-setup.exe",
      ],
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("artifact manifest creation is canonical and verification checks all metadata", async () => {
  const { root, input } = fixture();
  const created = await createWindowsArtifactManifest(root, input);
  expect(created).toEqual({
    schema: 1,
    role: input.role,
    version: input.version,
    productKey,
    source: input.source,
    files: [
      {
        name: "AliasMode_0.1.0-beta.47_x64-offline-setup.exe",
        bytes: 17,
        sha256: "8c21094c66240b02134df384b2b1765a739fa5d13deab4a463fb000ad9975971",
      },
      {
        name: "AliasMode_0.1.0-beta.47_x64-setup.exe",
        bytes: 17,
        sha256: "73e7f9bb4b53d0af469cd267c59524001a40d8dafd9aebe8995df66fb0a73388",
      },
    ],
  });
  expect(readFileSync(join(root, WINDOWS_ARTIFACT_MANIFEST_NAME), "utf8")).toBe(
    `${JSON.stringify(created, null, 2)}\n`,
  );
  expect(await verifyWindowsArtifactManifest(root, input)).toEqual(created);
});

test("artifact manifest rejects missing, extra, resized, and same-size tampered files", async () => {
  for (const mutate of [
    (root: string) => unlinkSync(join(root, "AliasMode_0.1.0-beta.47_x64-setup.exe")),
    (root: string) => writeFileSync(join(root, "unexpected.txt"), "extra"),
    (root: string) => writeFileSync(join(root, "AliasMode_0.1.0-beta.47_x64-setup.exe"), "different-size"),
    (root: string) => writeFileSync(join(root, "AliasMode_0.1.0-beta.47_x64-setup.exe"), "MZ-evil-installer"),
  ]) {
    const { root, input } = fixture();
    await createWindowsArtifactManifest(root, input);
    mutate(root);
    await expect(verifyWindowsArtifactManifest(root, input)).rejects.toThrow();
  }
});

test("artifact manifest rejects extra files before creation", async () => {
  const { root, input } = fixture();
  writeFileSync(join(root, "unexpected.txt"), "extra");
  await expect(createWindowsArtifactManifest(root, input)).rejects.toThrow("exactly");
});

test("artifact manifest rejects canonical manifest and identity tampering", async () => {
  for (const mutate of [
    (manifest: Record<string, unknown>) => { manifest.version = "0.1.0-beta.48"; },
    (manifest: Record<string, unknown>) => { manifest.productKey = "b".repeat(64); },
    (manifest: Record<string, unknown>) => { manifest.role = "changed"; },
    (manifest: Record<string, unknown>) => { manifest.source = "git-tree:changed"; },
    (manifest: Record<string, any>) => { manifest.files[0].sha256 = "c".repeat(64); },
  ]) {
    const { root, input } = fixture();
    await createWindowsArtifactManifest(root, input);
    const path = join(root, WINDOWS_ARTIFACT_MANIFEST_NAME);
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    mutate(manifest);
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(verifyWindowsArtifactManifest(root, input)).rejects.toThrow("manifest");
  }

  const { root, input } = fixture();
  await createWindowsArtifactManifest(root, input);
  const path = join(root, WINDOWS_ARTIFACT_MANIFEST_NAME);
  writeFileSync(path, JSON.stringify(JSON.parse(readFileSync(path, "utf8"))));
  await expect(verifyWindowsArtifactManifest(root, input)).rejects.toThrow("canonical");
});
