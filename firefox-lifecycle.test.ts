import { expect, test } from "bun:test";
import { matchFirefoxProcesses } from "./firefox-lifecycle.ts";

const identity = {
  binaryPath: "/opt/aliasmode/firefox",
  userDataDir: "/profiles/profile one",
  ownerBinaryPath: "/opt/aliasmode/node",
  generation: "generation-one",
};

test("Firefox ownership matches executable and exact profile argument without CDP", () => {
  expect(matchFirefoxProcesses(identity, {
    incomplete: false,
    records: [
      { pid: 10, executablePath: identity.binaryPath, argv: [identity.binaryPath, "-profile", identity.userDataDir, "-juggler-pipe"] },
      { pid: 11, executablePath: identity.binaryPath, argv: [identity.binaryPath, "-profile", identity.userDataDir + "2"] },
      { pid: 12, executablePath: identity.binaryPath, argv: [identity.binaryPath, "-contentproc"] },
      { pid: 13, executablePath: identity.ownerBinaryPath, argv: [identity.ownerBinaryPath, "firefox-worker.mjs", "--aliasmode-firefox-owner=generation-one"] },
      { pid: 14, executablePath: identity.ownerBinaryPath, argv: [identity.ownerBinaryPath, "firefox-worker.mjs", "--aliasmode-firefox-owner=generation-one-extra"] },
    ],
  })).toEqual({ browsers: [10], owners: [13] });
});

test("Firefox ownership matches quoted Windows paths and rejects prefix collisions", () => {
  const windows = { ...identity, binaryPath: "C:\\Alias Mode\\firefox.exe", userDataDir: "C:\\Profiles\\profile one", ownerBinaryPath: "C:\\Alias Mode\\node.exe" };
  expect(matchFirefoxProcesses(windows, {
    incomplete: false,
    records: [
      { pid: 20, executablePath: windows.binaryPath, commandLine: '"C:\\Alias Mode\\firefox.exe" -no-remote -profile "C:\\Profiles\\profile one" -juggler-pipe' },
      { pid: 21, executablePath: windows.binaryPath, commandLine: '"C:\\Alias Mode\\firefox.exe" -profile "C:\\Profiles\\profile one2" -juggler-pipe' },
      { pid: 22, executablePath: windows.binaryPath, commandLine: '"C:\\Alias Mode\\firefox.exe" -profile "C:\\Profiles\\other" --label="-profile C:\\Profiles\\profile one"' },
    ],
  }, true)).toEqual({ browsers: [20], owners: [] });
});

test("Firefox ownership preserves uncertain or foreign directory holders", () => {
  const argv = [identity.binaryPath, "-profile", identity.userDataDir];
  for (const executablePath of [null, "/opt/other/firefox"]) {
    expect(matchFirefoxProcesses(identity, { incomplete: false, records: [{ pid: 30, executablePath, argv }] })).toBeNull();
  }
  expect(matchFirefoxProcesses(identity, { incomplete: true, records: [] })).toBeNull();
  expect(matchFirefoxProcesses(identity, { incomplete: false, records: [] })).toEqual({ browsers: [], owners: [] });
});
