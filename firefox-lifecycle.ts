import { realpathSync } from "node:fs";
import { resolve, win32 } from "node:path";
import type { HostProcessSnapshot } from "./launcher.ts";

export interface FirefoxProcessIdentity {
  binaryPath: string;
  userDataDir: string;
  ownerBinaryPath: string;
  generation: string;
}

function commandArgs(line: string): string[] {
  const args: string[] = [];
  let value = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === "\\") {
      let count = 1;
      while (line[i + 1] === "\\") { count++; i++; }
      if (line[i + 1] === '"') {
        value += "\\".repeat(Math.floor(count / 2));
        i++;
        if (count % 2) value += '"';
        else quoted = !quoted;
      } else value += "\\".repeat(count);
      started = true;
    } else if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (/\s/.test(char) && !quoted) {
      if (started) args.push(value);
      value = "";
      started = false;
    } else {
      value += char;
      started = true;
    }
  }
  if (started) args.push(value);
  return args;
}

function executablePath(value: string, windows: boolean): string {
  if (windows) return win32.normalize(value).toLowerCase();
  const path = value.replace(/ \(deleted\)$/, "");
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** No PID-only or executable-name ownership: match the exact profile or owner generation. */
export function matchFirefoxProcesses(
  identity: FirefoxProcessIdentity,
  snapshot: HostProcessSnapshot,
  windows = process.platform === "win32",
): { browsers: number[]; owners: number[] } | null {
  if (snapshot.incomplete) return null;
  const browsers: number[] = [];
  const owners: number[] = [];
  const profilePath = (value: string) => windows ? win32.normalize(value).toLowerCase() : value;
  for (const record of snapshot.records) {
    const args = record.argv ?? commandArgs(record.commandLine ?? "");
    const holdsProfile = args.some((arg, index) => arg === "-profile"
      && args[index + 1] !== undefined
      && profilePath(args[index + 1]!) === profilePath(identity.userDataDir));
    const ownsWorker = args.includes(`--aliasmode-firefox-owner=${identity.generation}`);
    if (!holdsProfile && !ownsWorker) continue;
    if (!record.executablePath || record.executablePathExact === false) return null;
    const actual = executablePath(record.executablePath, windows);
    if (holdsProfile) {
      if (actual !== executablePath(identity.binaryPath, windows)) return null;
      browsers.push(record.pid);
    }
    if (ownsWorker) {
      if (actual !== executablePath(identity.ownerBinaryPath, windows)) return null;
      owners.push(record.pid);
    }
  }
  return { browsers, owners };
}
