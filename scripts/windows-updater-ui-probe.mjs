import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const inputPath = process.argv[2] ?? "";
const outputPath = process.argv[3] ?? "";

async function readInput() {
  let text = inputPath ? await readFile(inputPath, "utf8") : "";
  if (!inputPath) {
    for await (const chunk of process.stdin) text += chunk;
  }
  const input = JSON.parse(text);
  if (typeof input?.endpoint !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(input.endpoint)) {
    throw new Error("desktop debug endpoint is invalid");
  }
  if (typeof input?.candidateVersion !== "string" || input.candidateVersion.length === 0) {
    throw new Error("candidate version is missing");
  }
  if (typeof input?.dashboardOrigin !== "string" ||
      !/^http:\/\/127\.0\.0\.1:\d+$/.test(input.dashboardOrigin)) {
    throw new Error("dashboard origin is invalid");
  }
  const actions = new Set([
    "click-update",
    "click-update-and-wait-error",
    "verify-update-result",
  ]);
  if (!actions.has(input?.action)) {
    throw new Error("desktop UI probe action is invalid");
  }
  if (input.action === "verify-update-result" &&
      (typeof input?.sourceVersion !== "string" || input.sourceVersion.length === 0)) {
    throw new Error("source version is missing");
  }
  return input;
}

async function writeResult(result) {
  const text = `${JSON.stringify(result)}\n`;
  if (outputPath) {
    await writeFile(outputPath, text, "utf8");
  } else {
    process.stdout.write(text);
  }
}

async function findDashboardPage(browser, dashboardOrigin) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const page = browser.contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith(`${dashboardOrigin}/`));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("installed AliasMode dashboard target was not found");
}

async function main() {
  const input = await readInput();
  const browser = await chromium.connectOverCDP(input.endpoint, { timeout: 30_000 });
  try {
    const page = await findDashboardPage(browser, input.dashboardOrigin);
    if (input.action === "verify-update-result") {
      const result = page.locator(".update-banner.update-result.success");
      await result.waitFor({ state: "visible", timeout: 60_000 });
      const title = (await result.locator("strong").innerText()).trim();
      const detail = (await result.locator(".update-copy span").innerText()).trim();
      if (title !== `AliasMode ${input.candidateVersion} installed successfully.` ||
          detail !== `Updated from ${input.sourceVersion} and verified the installed app after restart.`) {
        throw new Error("durable updater result did not confirm the exact version handoff");
      }
      await writeResult({ ok: true, action: "verified-durable-success" });
      return;
    }

    const banner = page.locator(".update-banner").filter({
      has: page.getByRole("button", { name: "Update now", exact: true }),
    });
    await banner.waitFor({ state: "visible", timeout: 60_000 });
    const announcedVersion = await banner.locator('[role="status"] strong').innerText();
    if (announcedVersion.trim() !== `AliasMode ${input.candidateVersion} is available.`) {
      throw new Error("visible update banner announced a different version");
    }
    const updateButton = banner.getByRole("button", { name: "Update now", exact: true });
    await updateButton.waitFor({ state: "visible", timeout: 30_000 });
    if (!(await updateButton.isEnabled())) throw new Error("visible Update now action was disabled");
    await updateButton.click({ noWaitAfter: true });
    if (input.action === "click-update-and-wait-error") {
      await banner.locator('[role="alert"]').waitFor({ state: "visible", timeout: 120_000 });
      await updateButton.waitFor({ state: "visible", timeout: 30_000 });
      if (!(await updateButton.isEnabled())) throw new Error("Update now did not reset after rejection");
      await writeResult({ ok: true, action: "visible-update-rejected" });
      return;
    }
    await writeResult({ ok: true, action: "visible-update-now" });
  } finally {
    await browser.close().catch(() => undefined);
  }
}

main().catch(() => {
  process.stderr.write("AliasMode updater UI probe failed\n");
  process.exitCode = 1;
});
