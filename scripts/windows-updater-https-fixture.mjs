import { createReadStream, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASES_ROUTE = "/repos/aliasmode/aliasmode/releases?per_page=10";

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`fixture ${name} is missing`);
  }
  return value;
}

export function normalizeFixtureConfig(input) {
  const candidateVersion = requireString(input?.candidateVersion, "candidate version");
  const candidateTag = `v${candidateVersion}`;
  const installerName = `AliasMode_${candidateVersion}_x64-setup.exe`;
  const releaseBase = `/aliasmode/aliasmode/releases/download/${candidateTag}`;
  const manifestRoute = `${releaseBase}/latest-v2.json`;
  const installerRoute = `${releaseBase}/${installerName}`;
  const manifestUrl = `https://github.com${manifestRoute}`;
  const installerUrl = `https://github.com${installerRoute}`;

  if (input?.manifestUrl !== manifestUrl || input?.installerUrl !== installerUrl) {
    throw new Error("fixture release URLs are not canonical");
  }

  return {
    candidateVersion,
    candidateTag,
    prerelease: candidateVersion.includes("-"),
    installerName,
    manifestRoute,
    installerRoute,
    manifestUrl,
    installerUrl,
    manifestPath: resolve(requireString(input?.manifestPath, "manifest path")),
    installerPath: resolve(requireString(input?.installerPath, "installer path")),
    certificatePath: resolve(requireString(input?.certificatePath, "certificate path")),
    privateKeyPath: resolve(requireString(input?.privateKeyPath, "private key path")),
    statePath: resolve(requireString(input?.statePath, "state path")),
  };
}

export function releaseList(config) {
  return [{
    tag_name: config.candidateTag,
    draft: false,
    prerelease: config.prerelease,
    body: "## Highlights\n- Signed Windows update acceptance candidate",
    assets: [
      {
        name: "latest-v2.json",
        browser_download_url: config.manifestUrl,
      },
      {
        name: config.installerName,
        browser_download_url: config.installerUrl,
      },
      {
        name: `${config.installerName}.sig`,
        browser_download_url: `${config.installerUrl}.sig`,
      },
    ],
  }];
}

export function routeForRequest(config, method, requestHost, requestUrl) {
  if (method !== "GET" || typeof requestHost !== "string" || typeof requestUrl !== "string") {
    return "rejected";
  }
  const normalizedHost = requestHost.toLowerCase();
  if (normalizedHost === "api.github.com" && requestUrl === RELEASES_ROUTE) return "releaseList";
  if (normalizedHost === "github.com" && requestUrl === config.manifestRoute) return "manifest";
  if (normalizedHost === "github.com" && requestUrl === config.installerRoute) return "installer";
  return "rejected";
}

export function safeFixtureState(ready, counts) {
  return {
    version: 1,
    ready,
    counts: {
      releaseList: counts.releaseList,
      manifest: counts.manifest,
      installer: counts.installer,
      rejected: counts.rejected,
    },
  };
}

function writeState(statePath, state) {
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  const body = `${JSON.stringify(state)}\n`;
  writeFileSync(temporaryPath, body, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(temporaryPath, statePath);
  } catch {
    writeFileSync(statePath, body, { encoding: "utf8", mode: 0o600 });
  }
}

function sendJson(response, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": body.length,
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

export async function startFixture(input) {
  const config = normalizeFixtureConfig(input);
  const manifest = readFileSync(config.manifestPath);
  const installerSize = statSync(config.installerPath).size;
  const counts = { releaseList: 0, manifest: 0, installer: 0, rejected: 0 };
  const updateState = (ready = true) => writeState(config.statePath, safeFixtureState(ready, counts));

  const server = createServer({
    cert: readFileSync(config.certificatePath),
    key: readFileSync(config.privateKeyPath),
    minVersion: "TLSv1.2",
  }, (request, response) => {
    const route = routeForRequest(config, request.method, request.headers.host, request.url);
    counts[route] += 1;
    updateState();

    if (route === "releaseList") {
      sendJson(response, releaseList(config));
      return;
    }
    if (route === "manifest") {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": manifest.length,
        "content-type": "application/json; charset=utf-8",
      });
      response.end(manifest);
      return;
    }
    if (route === "installer") {
      response.writeHead(200, {
        "accept-ranges": "none",
        "cache-control": "no-store",
        "content-length": installerSize,
        "content-type": "application/vnd.microsoft.portable-executable",
      });
      const stream = createReadStream(config.installerPath);
      stream.on("error", () => response.destroy());
      stream.pipe(response);
      return;
    }
    response.writeHead(404, {
      "cache-control": "no-store",
      "content-length": 0,
    });
    response.end();
  });

  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise((resolveReady, rejectReady) => {
    server.once("error", rejectReady);
    server.listen(443, "127.0.0.1", () => {
      server.off("error", rejectReady);
      resolveReady();
    });
  });
  updateState();
  return server;
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("fixture config path is required");
  await startFixture(JSON.parse(readFileSync(configPath, "utf8")));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch(() => {
    process.stderr.write("AliasMode updater HTTPS fixture failed\n");
    process.exitCode = 1;
  });
}
