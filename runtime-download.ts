/**
 * Resumable download of one pinned file, for the runtimes the app downloads on first
 * use. A broken download resumes with a Range request, also in a later app run. It
 * retries with backoff and retries a download that stalls. The same steps as the
 * Firefox font pack download.
 */
import { existsSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";

export interface ResumableDownloadDeps {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  /** Download attempts; a partial download resumes on the next. */
  attempts?: number;
  /** A download that receives nothing for this long is retried. */
  stallMs?: number;
}

/** Start byte of a 206 response, from its Content-Range header. */
function rangeStart(response: Response): number | undefined {
  const match = /^bytes (\d+)-/.exec(response.headers.get("content-range") ?? "");
  return match ? Number(match[1]) : undefined;
}

async function receive(
  url: string,
  partial: string,
  have: number,
  deps: ResumableDownloadDeps,
  progress: (bytes: number) => void,
): Promise<void> {
  const controller = new AbortController();
  const stallMs = deps.stallMs ?? 60_000;
  let timer = setTimeout(() => controller.abort(), stallMs);
  const alive = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), stallMs); };
  try {
    const response = await (deps.fetch ?? fetch)(url, {
      headers: have > 0 ? { range: `bytes=${have}-` } : {},
      signal: controller.signal,
    });
    const resume = have > 0 && response.status === 206 && rangeStart(response) === have;
    if (!resume && response.status !== 200) {
      // The saved part no longer lines up with what the server sends: start over.
      if (response.status === 206 || response.status === 416) rmSync(partial, { force: true });
      throw new Error(`download answered HTTP ${response.status}`);
    }
    if (!response.body) throw new Error("download returned no data");
    const file = await open(partial, resume ? "a" : "w");
    let written = resume ? have : 0;
    try {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        alive();
        await file.write(value);
        written += value.byteLength;
        progress(written);
      }
    } finally {
      await file.close();
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download `url` to `partial` until it holds `size` bytes, resuming what an earlier
 * attempt or app run saved. `progress` receives the bytes saved so far.
 */
export async function downloadResumable(
  url: string,
  partial: string,
  size: number,
  deps: ResumableDownloadDeps = {},
  progress: (bytes: number) => void = () => {},
): Promise<void> {
  const attempts = deps.attempts ?? 5;
  let lastError: unknown = new Error("download did not run");
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let have = existsSync(partial) ? statSync(partial).size : 0;
    if (have > size) {
      rmSync(partial, { force: true });
      have = 0;
    }
    progress(have);
    if (have === size) return;
    try {
      await receive(url, partial, have, deps, progress);
      const received = statSync(partial).size;
      if (received === size) return;
      if (received > size) rmSync(partial, { force: true });
      throw new Error("download ended early");
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await (deps.sleep ?? Bun.sleep)(Math.min(30_000, 1000 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

/** A browser runtime download in progress, as the dashboard shows it. */
export interface RuntimeDownload {
  /** The profiles that wait for it: "aliasmode" (Chromium 159), "cloakbrowser", or "firefox" (a font pack). */
  runtime: "aliasmode" | "cloakbrowser" | "firefox";
  receivedBytes: number;
  totalBytes: number;
}

const activeDownloads = new Map<string, Omit<RuntimeDownload, "receivedBytes">>();

/**
 * Report the download into `partial` as in progress until `download` settles. Its
 * progress is the size of `partial`, so this only observes the download.
 */
export async function trackRuntimeDownload<T>(
  runtime: RuntimeDownload["runtime"],
  partial: string,
  totalBytes: number,
  download: () => Promise<T>,
): Promise<T> {
  activeDownloads.set(partial, { runtime, totalBytes });
  try {
    return await download();
  } finally {
    activeDownloads.delete(partial);
  }
}

/** The browser runtime downloads in progress now. */
export function runtimeDownloads(): RuntimeDownload[] {
  return [...activeDownloads].map(([partial, { runtime, totalBytes }]) => ({
    runtime,
    receivedBytes: Math.min(statSync(partial, { throwIfNoEntry: false })?.size ?? 0, totalBytes),
    totalBytes,
  }));
}
