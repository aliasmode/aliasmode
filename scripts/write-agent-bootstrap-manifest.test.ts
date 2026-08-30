import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ALIASMODE_VERSION } from "../version.ts";
import { buildAgentBootstrapManifest } from "./write-agent-bootstrap-manifest.ts";

test("agent bootstrap manifest pins an exact installer URL and SHA-256", () => {
  const dir = mkdtempSync(join(tmpdir(), "aliasmode-agent-manifest-"));
  const name = `AliasMode_${ALIASMODE_VERSION}_x64-offline-setup.exe`;
  const releaseBase = `https://github.com/aliasmode/aliasmode/releases/download/v${ALIASMODE_VERSION}`;
  try {
    const installer = join(dir, name);
    writeFileSync(installer, "installer");
    expect(buildAgentBootstrapManifest({
      installer,
      releaseBase,
    })).toEqual({
      schema: 1,
      version: ALIASMODE_VERSION,
      wingetId: "AliasMode.AliasMode",
      installer: {
        name,
        url: `${releaseBase}/${name}`,
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
