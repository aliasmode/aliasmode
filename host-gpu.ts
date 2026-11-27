/**
 * The GPU vendor of this computer, which new profiles keep to (GPU-family rule): a profile that
 * claims another vendor's GPU draws its pages on this one, and a site can compare the two.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { intelMacGraphicsVendor } from "./firefox-config.ts";

export type GpuVendor = "nvidia" | "intel" | "amd" | "apple" | "qualcomm";

// PCI vendor ids. Virtual and server display adapters (Hyper-V, VMware, VirtualBox, QEMU, ASPEED)
// have none here: such a computer draws in software and has no GPU family.
const PCI_VENDORS: Record<string, GpuVendor> = { "10de": "nvidia", "8086": "intel", "1002": "amd", "1022": "amd", "5143": "qualcomm" };

/** One display adapter from `Win32_VideoController`. */
interface WindowsAdapter { PNPDeviceID?: unknown; CurrentHorizontalResolution?: unknown }

/**
 * The vendor of the adapter Chrome and Firefox draw on, from `Get-CimInstance Win32_VideoController`
 * as JSON: the one that drives a display, as the integrated GPU does in a laptop with two.
 */
export function windowsGpuVendor(json: string): GpuVendor | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return undefined; }
  const adapters = (Array.isArray(parsed) ? parsed : [parsed]) as WindowsAdapter[];
  const vendorOf = (adapter: WindowsAdapter): GpuVendor | undefined => {
    const id = String(adapter?.PNPDeviceID ?? "").toUpperCase();
    if (/^ACPI\\QCOM/.test(id)) return "qualcomm";
    return PCI_VENDORS[/^PCI\\VEN_([0-9A-F]{4})/.exec(id)?.[1]?.toLowerCase() ?? ""];
  };
  const known = adapters.filter((adapter) => vendorOf(adapter));
  const active = known.find((adapter) => Number(adapter.CurrentHorizontalResolution) > 0);
  return vendorOf(active ?? known[0]!);
}

/** The vendor of the boot display GPU, or of the first GPU, under /sys/class/drm. */
export function linuxGpuVendor(drm = "/sys/class/drm", read = (path: string) => readFileSync(path, "utf8")): GpuVendor | undefined {
  let cards: string[];
  try { cards = readdirSync(drm).filter((name) => /^card\d+$/.test(name)).sort(); } catch { return undefined; }
  const vendors = cards.flatMap((card) => {
    try {
      const vendor = PCI_VENDORS[read(join(drm, card, "device", "vendor")).trim().replace(/^0x/, "").toLowerCase()];
      let boot = false;
      try { boot = read(join(drm, card, "device", "boot_vga")).trim() === "1"; } catch {}
      return vendor ? [{ vendor, boot }] : [];
    } catch {
      return [];
    }
  });
  return (vendors.find((card) => card.boot) ?? vendors[0])?.vendor;
}

function spawnText(command: string[]): string {
  try {
    const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "ignore", timeout: 15_000 });
    return result.exitCode === 0 ? result.stdout.toString() : "";
  } catch {
    return "";
  }
}

/** Detect this computer's GPU vendor. Undefined when it has none that a GPU family covers. */
export function detectHostGpu(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  run: (command: string[]) => string = spawnText,
): GpuVendor | undefined {
  if (platform === "darwin") {
    if (arch === "arm64") return "apple";
    return intelMacGraphicsVendor(run(["/usr/sbin/system_profiler", "SPDisplaysDataType", "-json"]));
  }
  if (platform === "linux") return linuxGpuVendor();
  if (platform === "win32") {
    // The full path also works when PATH has no PowerShell folder.
    const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = "Get-CimInstance Win32_VideoController -ErrorAction Stop | Select-Object PNPDeviceID, CurrentHorizontalResolution | ConvertTo-Json -Compress";
    return windowsGpuVendor(run([powershell, "-NoProfile", "-NonInteractive", "-Command", script]));
  }
  return undefined;
}

let cached: { vendor: GpuVendor | undefined } | undefined;

/** This computer's GPU vendor, read once per app run. */
export function hostGpuVendor(): GpuVendor | undefined {
  cached ??= { vendor: detectHostGpu() };
  return cached.vendor;
}
