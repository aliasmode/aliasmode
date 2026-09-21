import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { startFirefoxOwner } from "../firefox-runtime.ts";

const [browser, directory, record, mode] = process.argv.slice(2);
if (!browser || !directory || !record) throw new Error("Firefox owner smoke manager input is missing");

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const writeOwner = (owner) => writeFile(record, JSON.stringify(owner), { mode: 0o600 });
await startFirefoxOwner({
  profileId: "firefox-owner-smoke",
  executablePath: browser,
  executableSha256: await sha256File(browser),
  userDataDir: directory,
  config: {},
  headless: mode !== "headed",
  timeoutMs: 120_000,
}, { onSpawn: writeOwner, onReady: writeOwner });
