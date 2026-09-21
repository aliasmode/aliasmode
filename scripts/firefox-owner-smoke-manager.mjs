import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createFirefoxProfileConfig, normalizeFirefoxProfileConfig } from "../firefox-config.ts";
import { startFirefoxOwner } from "../firefox-runtime.ts";

const [browser, directory, record, configPath, mode] = process.argv.slice(2);
if (!browser || !directory || !record || !configPath) throw new Error("Firefox owner smoke manager input is missing");

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function savedConfig() {
  try {
    return normalizeFirefoxProfileConfig(JSON.parse(await readFile(configPath, "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const value = createFirefoxProfileConfig(1920, 1080);
    await writeFile(configPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    return value;
  }
}

const firefox = await savedConfig();
const writeOwner = (owner) => writeFile(record, JSON.stringify(owner), { mode: 0o600 });
await startFirefoxOwner({
  profileId: "firefox-owner-smoke",
  executablePath: browser,
  executableSha256: await sha256File(browser),
  userDataDir: directory,
  config: firefox.config,
  headless: mode !== "headed",
  timeoutMs: 120_000,
}, { onSpawn: writeOwner, onReady: writeOwner });
