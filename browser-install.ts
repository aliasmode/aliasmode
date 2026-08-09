import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const WRAPPER_VERSION = "0.4.11";
const PATH_KEY = "CLOAKBROWSER_BINARY_PATH";
const HASH_KEY = "CLOAKBROWSER_BINARY_SHA256";

export interface BrowserInstallOptions {
  cwd?: string;
  runInstaller?: () => Promise<{ code: number; output: string }>;
  exists?: (path: string) => boolean;
  hashFile?: (path: string) => Promise<string>;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveDone, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolveDone);
  });
  return hash.digest("hex");
}

async function runOfficialInstaller(cwd: string): Promise<{ code: number; output: string }> {
  const env = { ...process.env };
  // This command exists to repair a missing/stale deployment. Do not let the
  // wrapper treat the very override we are replacing as its install target.
  // Keep CLOAKBROWSER_LICENSE_KEY so licensed servers still receive their
  // entitled build, but force the source/download path back to the official one.
  delete env.CLOAKBROWSER_BINARY_PATH;
  delete env.CLOAKBROWSER_BINARY_SHA256;
  delete env.CLOAKBROWSER_DOWNLOAD_URL;
  const child = Bun.spawn(
    [process.execPath, "x", `cloakbrowser@${WRAPPER_VERSION}`, "install"],
    { cwd, env, stdout: "pipe", stderr: "inherit" },
  );
  const output = await new Response(child.stdout).text();
  process.stdout.write(output);
  return { code: await child.exited, output };
}

function installedPath(output: string, exists: (path: string) => boolean): string | null {
  const ansi = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
  const lines = output.split(/\r?\n/).map((line) => line.replace(ansi, "").trim()).filter(Boolean);
  return lines.reverse().find((line) => exists(line)) ?? null;
}

export function browserEnvText(current: string, binaryPath: string, sha256: string, newline = "\n"): string {
  const owned = new RegExp(`^\\s*(?:${PATH_KEY}|${HASH_KEY})\\s*=.*$`, "i");
  const kept = current.split(/\r?\n/).filter((line) => !owned.test(line));
  while (kept.length && !kept.at(-1)?.trim()) kept.pop();
  if (kept.length) kept.push("");
  kept.push(`${PATH_KEY}=${binaryPath}`, `${HASH_KEY}=${sha256.toLowerCase()}`, "");
  return kept.join(newline);
}

/** Download the official signed binary, pin its exact path/hash, and return both. */
export async function installCloakBrowser(opts: BrowserInstallOptions = {}): Promise<{ path: string; sha256: string }> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const run = opts.runInstaller ?? (() => runOfficialInstaller(cwd));
  const exists = opts.exists ?? existsSync;
  const result = await run();
  if (result.code !== 0) throw new Error(`official CloakBrowser installer exited with code ${result.code}`);
  const path = installedPath(result.output, exists);
  if (!path) throw new Error("official CloakBrowser installer completed but did not report a readable binary path");

  const sha256 = (await (opts.hashFile ?? sha256File)(path)).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("installed CloakBrowser returned an invalid SHA-256");

  const envPath = resolve(cwd, ".env");
  const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const newline = current.includes("\r\n") || process.platform === "win32" ? "\r\n" : "\n";
  writeFileSync(envPath, browserEnvText(current, path, sha256, newline), "utf8");
  return { path, sha256 };
}
