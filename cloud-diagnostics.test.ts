import { expect, test } from "bun:test";
import { CloudDiagnostics, normalizeCloudDiagnostics } from "./cloud-diagnostics.ts";

test("Cloud diagnostics keep only fixed timestamp and type fields", () => {
  let now = 100;
  const diagnostics = new CloudDiagnostics(() => ++now);
  diagnostics.record("open_started");
  diagnostics.record("session_restore_context_timeout");
  diagnostics.record("browser_teardown_unconfirmed");

  const snapshot = diagnostics.snapshot();
  expect(snapshot).toEqual([
    { timestamp: 101, type: "open_started" },
    { timestamp: 102, type: "session_restore_context_timeout" },
    { timestamp: 103, type: "browser_teardown_unconfirmed" },
  ]);

  snapshot[0]!.timestamp = 999;
  expect(diagnostics.snapshot()[0]!.timestamp).toBe(101);
  expect(normalizeCloudDiagnostics([
    { timestamp: 5, type: "open_started", secret: "must not survive" },
    { timestamp: 6, type: "unknown" },
  ])).toEqual([{ timestamp: 5, type: "open_started" }]);
  expect(() => diagnostics.record("secret raw event" as any)).toThrow("unknown Cloud diagnostic event");
});

test("Cloud diagnostics discard the oldest event after the recent-event window fills", () => {
  let now = 0;
  const diagnostics = new CloudDiagnostics(() => ++now);
  for (let index = 0; index < 101; index++) diagnostics.record("open_started");

  const snapshot = diagnostics.snapshot();
  expect(snapshot).toHaveLength(100);
  expect(snapshot[0]!.timestamp).toBe(2);
  expect(snapshot.at(-1)!.timestamp).toBe(101);
});
