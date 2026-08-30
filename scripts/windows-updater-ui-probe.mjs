import { chromium } from "playwright-core";

async function readInput() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const input = JSON.parse(text);
  if (typeof input?.endpoint !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(input.endpoint)) {
    throw new Error("desktop debug endpoint is invalid");
  }
  if (typeof input?.candidateVersion !== "string" || input.candidateVersion.length === 0) {
    throw new Error("candidate version is missing");
  }
  return input;
}

async function findDashboardPage(browser) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const page = browser.contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith("http://127.0.0.1:"));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("installed AliasMode dashboard target was not found");
}

async function main() {
  const input = await readInput();
  const browser = await chromium.connectOverCDP(input.endpoint, { timeout: 30_000 });
  try {
    const page = await findDashboardPage(browser);
    const banner = page.locator(".update-banner");
    await banner.waitFor({ state: "visible", timeout: 60_000 });
    const announcedVersion = await banner.locator('[role="status"] strong').innerText();
    if (announcedVersion.trim() !== `AliasMode ${input.candidateVersion} is available.`) {
      throw new Error("visible update banner announced a different version");
    }
    const updateButton = banner.getByRole("button", { name: "Update now", exact: true });
    await updateButton.waitFor({ state: "visible", timeout: 30_000 });
    if (!(await updateButton.isEnabled())) throw new Error("visible Update now action was disabled");
    await updateButton.click({ noWaitAfter: true });
    process.stdout.write('{"ok":true,"action":"visible-update-now"}\n');
  } finally {
    await browser.close().catch(() => undefined);
  }
}

main().catch(() => {
  process.stderr.write("AliasMode updater UI probe failed\n");
  process.exitCode = 1;
});
