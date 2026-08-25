import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildAgentBootstrapManifest } from "./write-agent-bootstrap-manifest.ts";

test("agent bootstrap manifest pins an exact installer URL and SHA-256", () => {
  const dir = mkdtempSync(join(tmpdir(), "aliasmode-agent-manifest-"));
  try {
    const installer = join(dir, "AliasMode_0.1.0-beta.40_x64-setup.exe");
    writeFileSync(installer, "installer");
    expect(buildAgentBootstrapManifest({
      installer,
      releaseBase: "https://github.com/aliasmode/aliasmode/releases/download/v0.1.0-beta.40",
    })).toEqual({
      schema: 1,
      version: "0.1.0-beta.40",
      wingetId: "AliasMode.AliasMode",
      installer: {
        name: "AliasMode_0.1.0-beta.40_x64-setup.exe",
        url: "https://github.com/aliasmode/aliasmode/releases/download/v0.1.0-beta.40/AliasMode_0.1.0-beta.40_x64-setup.exe",
        sha256: createHash("sha256").update("installer").digest("hex"),
        size: 9,
      },
    });
    expect(() => buildAgentBootstrapManifest({
      installer,
      releaseBase: "https://github.com/aliasmode/aliasmode/releases/latest",
    })).toThrow("exact AliasMode GitHub Release URL");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
