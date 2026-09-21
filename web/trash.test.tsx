import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TrashProfileView } from "../proxy-tools-types.ts";
import { filterTrash, TrashPage } from "./trash.tsx";
import { proxyResultPage } from "./proxies.tsx";

const profiles: TrashProfileView[] = Array.from({ length: 8000 }, (_, i) => ({
  id: `p${i}`, name: `Profile ${i}`, group: i % 9 ? `Folder ${i % 9}` : "",
  trashedAt: 1000, canRestore: true, canPurge: true,
}));

test("Trash filters the complete selection by folder and name or ID before paging", () => {
  const folder = filterTrash(profiles, ["Folder 1"], "");
  expect(folder.length).toBeGreaterThan(800);
  expect(folder.every((p) => p.group === "Folder 1")).toBe(true);
  expect(proxyResultPage(folder, 0).items).toHaveLength(50);
  expect(filterTrash(profiles, [""], "").every((p) => p.group === "")).toBe(true);
  expect(filterTrash(profiles, null, " P7999 ").map((p) => p.id)).toEqual(["p7999"]);
  expect(filterTrash(profiles, null, "PROFILE 7999").map((p) => p.id)).toEqual(["p7999"]);
  expect(filterTrash(profiles, ["Folder 2"], "p7999")).toEqual([]);
});

test("Trash folder scope includes every profile across pages and remains independent of search", () => {
  const folders = ["Folder 1", "Folder 2"];
  const scope = filterTrash(profiles, folders, "");
  expect(scope).toHaveLength(profiles.filter((p) => folders.includes(p.group)).length);
  expect(scope.length).toBeGreaterThan(1700);
  expect(new Set(scope.map((p) => p.group))).toEqual(new Set(folders));
  expect(filterTrash(profiles, folders, "Profile 10").length).toBeLessThan(scope.length);
  expect(filterTrash(profiles, [], "")).toEqual([]);
});

test("Trash stays mounted but hidden during page navigation", () => {
  const inactive = renderToStaticMarkup(<TrashPage active={false} onChanged={async () => {}} />);
  const active = renderToStaticMarkup(<TrashPage active onChanged={async () => {}} />);
  expect(inactive).toContain('hidden=""');
  expect(active).not.toContain('hidden=""');
  expect(active.match(/disabled=""/g)!.length).toBeGreaterThan(0);
});
