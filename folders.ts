export interface FolderInfo {
  name: string;
  parentName?: string | null;
  label?: string;
}

export function folderTree<T extends FolderInfo>(folders: readonly T[]): Array<T & { depth: number; ancestors: string[] }> {
  const names = new Set(folders.map((folder) => folder.name));
  const children = new Map<string | null, T[]>();
  for (const folder of folders) {
    const parent = folder.parentName && names.has(folder.parentName) ? folder.parentName : null;
    const siblings = children.get(parent) ?? [];
    siblings.push(folder);
    children.set(parent, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => (a.label ?? a.name).localeCompare(b.label ?? b.name));
  const pending = (children.get(null) ?? []).map((folder) => ({ folder, ancestors: [] as string[] })).reverse();
  const result: Array<T & { depth: number; ancestors: string[] }> = [];
  while (pending.length) {
    const { folder, ancestors } = pending.pop()!;
    result.push({ ...folder, depth: ancestors.length, ancestors });
    const next = children.get(folder.name) ?? [];
    for (let i = next.length - 1; i >= 0; i--) pending.push({ folder: next[i]!, ancestors: [...ancestors, folder.name] });
  }
  return result;
}

export function folderGrantPermission(
  folders: readonly FolderInfo[],
  grants: readonly { folderName: string; permission: "view" | "edit" }[],
  name: string,
  includeSelf = true,
): "view" | "edit" | "" {
  const ancestors = folderTree(folders).find((folder) => folder.name === name)?.ancestors ?? [];
  const names = new Set(includeSelf ? [...ancestors, name] : ancestors);
  const matching = grants.filter((grant) => names.has(grant.folderName));
  return matching.some((grant) => grant.permission === "edit") ? "edit" : matching.length ? "view" : "";
}

export function folderScope(folders: readonly FolderInfo[], name: string): Set<string> {
  return new Set(folderTree(folders)
    .filter((folder) => folder.name === name || folder.ancestors.includes(name))
    .map((folder) => folder.name));
}
