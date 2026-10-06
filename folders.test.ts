import { expect, test } from "bun:test";
import { folderGrantPermission, folderScope, folderTree } from "./folders.ts";

const folders = [
  { name: "Facebook/Fitness", parentName: "Facebook", label: "Fitness" },
  { name: "Facebook", parentName: null, label: "Facebook" },
  { name: "Facebook/Fitness/Gym", parentName: "Facebook/Fitness", label: "Gym" },
  { name: "Facebook/Literal", parentName: null },
  { name: "TikTok/Fitness", parentName: "TikTok", label: "Fitness" },
];

test("folder trees use explicit parents and keep visible orphan grants navigable", () => {
  const tree = folderTree(folders);
  expect(tree.map(({ name, depth }) => [name, depth])).toEqual([
    ["Facebook", 0], ["Facebook/Fitness", 1], ["Facebook/Fitness/Gym", 2],
    ["Facebook/Literal", 0], ["TikTok/Fitness", 0],
  ]);
  expect(tree[2]!.ancestors).toEqual(["Facebook", "Facebook/Fitness"]);
});

test("parent scope contains exactly its descendants, not literal prefix names", () => {
  expect([...folderScope(folders, "Facebook")]).toEqual(["Facebook", "Facebook/Fitness", "Facebook/Fitness/Gym"]);
  expect([...folderScope(folders, "Facebook/Fitness")]).toEqual(["Facebook/Fitness", "Facebook/Fitness/Gym"]);
  expect([...folderScope(folders, "Missing")]).toEqual([]);
});

test("folder access shows the strongest explicit ancestor grant and can exclude self", () => {
  const grants = [
    { folderName: "Facebook", permission: "view" as const },
    { folderName: "Facebook/Fitness", permission: "edit" as const },
  ];
  expect(folderGrantPermission(folders, grants, "Facebook/Fitness/Gym")).toBe("edit");
  expect(folderGrantPermission(folders, grants, "Facebook/Fitness", false)).toBe("view");
  expect(folderGrantPermission(folders, grants, "Facebook", false)).toBe("");
  expect(folderGrantPermission(folders, grants, "Facebook/Literal")).toBe("");
  expect(folderGrantPermission(folders, grants, "TikTok/Fitness")).toBe("");
});
