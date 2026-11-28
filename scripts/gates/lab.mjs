/**
 * Private files for the gates on GitHub's runners (this repo is public). The detection lab lives in the private
 * aliasmode-site repo, which a workflow here cannot check out, so its probe files travel encrypted in
 * scripts/gates/lab.enc; the runners' results leave the same way (artifacts and logs of a public repo are public).
 * AES-256-GCM over gzipped JSON. Key: $GATES_LAB_KEY (64 hex characters; the repo secret of that name), else
 * ~/.config/aliasmode-test/gates-lab.key.
 *   bun scripts/gates/lab.mjs pack <aliasmode-site checkout>   re-encrypt lab.enc after the lab changes
 *   bun scripts/gates/lab.mjs unpack <dir>                     write <dir>/tests/detection-lab (then gates.mjs --site <dir>)
 *   bun scripts/gates/lab.mjs seal <dir> <file>                encrypt a results folder
 *   bun scripts/gates/lab.mjs open <file> <dir>                decrypt one (for example a downloaded runner artifact)
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), "lab.enc");
const LAB = join("tests", "detection-lab");
// What run.mjs serves and diff.mjs reads; the research notes and candidates stay private.
const LAB_FILES = ["run.mjs", "diff.mjs", "lab.html", "lab.js", "probes"];

function key() {
  const file = join(homedir(), ".config", "aliasmode-test", "gates-lab.key");
  const hex = (process.env.GATES_LAB_KEY || (existsSync(file) ? readFileSync(file, "utf8") : "")).trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("GATES_LAB_KEY (64 hex characters) is not set");
  return Buffer.from(hex, "hex");
}
const walk = (path) => statSync(path).isDirectory() ? readdirSync(path).sort().flatMap((name) => walk(join(path, name))) : [path];
function seal(root, paths, file) {
  const files = {};
  for (const path of paths.flatMap(walk)) files[relative(root, path).split(sep).join("/")] = readFileSync(path).toString("base64");
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(gzipSync(JSON.stringify(files))), cipher.final()]);
  writeFileSync(file, Buffer.concat([iv, cipher.getAuthTag(), body]));
  console.log(`sealed ${Object.keys(files).length} files from ${root} into ${file}`);
}
function open(file, root) {
  const data = readFileSync(file);
  const decipher = createDecipheriv("aes-256-gcm", key(), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  const files = JSON.parse(gunzipSync(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()])).toString("utf8"));
  for (const [name, content] of Object.entries(files)) {
    const out = join(root, ...name.split("/"));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from(content, "base64"));
  }
  console.log(`opened ${Object.keys(files).length} files into ${root}`);
}

const [command, a, b] = process.argv.slice(2);
if (command === "pack" && a) seal(join(a, LAB), LAB_FILES.map((name) => join(a, LAB, name)), BUNDLE);
else if (command === "unpack" && a) open(BUNDLE, join(a, LAB));
else if (command === "seal" && a && b) seal(a, [a], b);
else if (command === "open" && a && b) open(a, b);
else { console.error("usage: lab.mjs pack <site checkout> | unpack <dir> | seal <dir> <file> | open <file> <dir>"); process.exit(2); }
