import { describe, expect, test } from "bun:test";
import {
  RELEASES_ROUTE,
  normalizeFixtureConfig,
  releaseList,
  routeForRequest,
  safeFixtureState,
} from "./windows-updater-https-fixture.mjs";

const version = "0.1.0-beta.46";
const tag = `v${version}`;
const installerName = `AliasMode_${version}_x64-setup.exe`;
const releaseBase = `/aliasmode/aliasmode/releases/download/${tag}`;
const config = normalizeFixtureConfig({
  candidateVersion: version,
  manifestUrl: `https://github.com${releaseBase}/latest-v2.json`,
  installerUrl: `https://github.com${releaseBase}/${installerName}`,
  manifestPath: "latest-v2.json",
  installerPath: installerName,
  certificatePath: "server.pem",
  privateKeyPath: "server.key",
  statePath: "fixture-state.json",
});

describe("Windows updater HTTPS fixture", () => {
  test("builds the one canonical candidate release", () => {
    expect(releaseList(config)).toEqual([{
      tag_name: tag,
      draft: false,
      prerelease: true,
      body: "## Highlights\n- Signed Windows update acceptance candidate",
      assets: [
        {
          name: "latest-v2.json",
          browser_download_url: `https://github.com${releaseBase}/latest-v2.json`,
        },
        {
          name: installerName,
          browser_download_url: `https://github.com${releaseBase}/${installerName}`,
        },
        {
          name: `${installerName}.sig`,
          browser_download_url: `https://github.com${releaseBase}/${installerName}.sig`,
        },
      ],
    }]);
  });

  test("accepts only exact production hosts, methods, paths, and query", () => {
    expect(routeForRequest(config, "GET", "api.github.com", RELEASES_ROUTE)).toBe("releaseList");
    expect(routeForRequest(config, "GET", "github.com", config.manifestRoute)).toBe("manifest");
    expect(routeForRequest(config, "GET", "github.com", config.installerRoute)).toBe("installer");

    for (const request of [
      ["POST", "api.github.com", RELEASES_ROUTE],
      ["GET", "api.github.com:443", RELEASES_ROUTE],
      ["GET", "api.github.com", "/repos/aliasmode/aliasmode/releases?per_page=100"],
      ["GET", "github.com", `${config.manifestRoute}?download=1`],
      ["GET", "github.com", `${config.installerRoute}.sig`],
      ["GET", "objects.githubusercontent.com", config.installerRoute],
    ] as const) {
      expect(routeForRequest(config, ...request)).toBe("rejected");
    }
  });

  test("publishes route counters without request metadata", () => {
    expect(safeFixtureState(true, {
      releaseList: 2,
      manifest: 2,
      installer: 1,
      rejected: 0,
      ignored: 9,
    })).toEqual({
      version: 1,
      ready: true,
      counts: {
        releaseList: 2,
        manifest: 2,
        installer: 1,
        rejected: 0,
      },
    });
  });

  test("rejects noncanonical manifest and installer URLs", () => {
    expect(() => normalizeFixtureConfig({
      candidateVersion: version,
      manifestUrl: `https://example.com${releaseBase}/latest-v2.json`,
      installerUrl: `https://github.com${releaseBase}/${installerName}`,
      manifestPath: "latest-v2.json",
      installerPath: installerName,
      certificatePath: "server.pem",
      privateKeyPath: "server.key",
      statePath: "fixture-state.json",
    })).toThrow("fixture release URLs are not canonical");
  });
});
