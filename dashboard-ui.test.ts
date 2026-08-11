import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = readFileSync(join(import.meta.dir, "web", "app.tsx"), "utf8");
const styles = readFileSync(join(import.meta.dir, "web", "styles.css"), "utf8");
const logo = readFileSync(join(import.meta.dir, "web", "alias-loop.svg"), "utf8");

test("dashboard packages the approved Alias Loop logo", () => {
  expect(app).toContain('import aliasLoopUrl from "./alias-loop.svg"');
  expect(app).toContain('<img src={aliasLoopUrl} alt="" />AliasMode');
  expect(styles).not.toContain(".brand::before");
  expect(logo).toContain('stroke="#111827"');
  expect(logo).toContain('stroke="#2457D6"');
  expect(logo).toContain('d="M152 96H320C380 96 416 136 416 196V316C416 376 376 416 316 416H196C136 416 96 376 96 316V288"');
  expect(logo).toContain('d="M96 288C96 240 136 208 184 208H280"');
});

test("dashboard exposes account settings and confirms mode switching", () => {
  expect(app).toContain('aria-label="Open Account and Settings"');
  expect(app).toContain("<ModeSwitchConfirmation");
  expect(app).toContain("Cloud profiles will not appear until you switch back");
  expect(app).toContain("does not upload them to Cloud automatically");
  expect(app).toContain("Accept and continue to Cloud");
  expect(app).toContain(">Stay Local</button>");
});

test("Account settings exposes fixed Cloud diagnostics without raw server messages", () => {
  expect(app).toContain("fetchCloudEvents");
  expect(app).toContain("Recent diagnostics");
  expect(app).toContain("CLOUD_DIAGNOSTIC_LABELS[event.type]");
  expect(app).toContain("They exclude profile data and credentials");
  expect(styles).toContain(".diagnostics-list");
});

test("dashboard lists the supported profile platforms", () => {
  for (const platform of [
    "x.com",
    "instagram.com",
    "facebook.com",
    "tiktok.com",
    "linkedin.com",
    "reddit.com",
    "telegram.org",
  ]) {
    expect(app).toContain(`value: "${platform}"`);
  }
});

test("Cloud rows expose Edit only while closed and unlocked", () => {
  expect(app).toContain("(!isCloudMode || (!p.running && !p.lockedBy))");
  expect(app).toContain("setEditExpectedVersion(p.expectedVersion ?? null)");
  expect(app).toContain("isCloudMode ? editExpectedVersion ?? undefined : undefined");
  expect(app).toContain("!isCloudMode && editTotp");
  expect(app).toContain("!isCloudMode && editMobile");
});
