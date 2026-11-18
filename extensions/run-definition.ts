/** Immutable, local run source snapshots. Never evaluates source or follows stored paths. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
const MAX_BYTES = 2 * 1024 * 1024;
const hash = (source: string) => createHash("sha256").update(source).digest("hex");
function file(dir: string, id: string): string {
 if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id) || path.basename(dir) !== "runs" || path.basename(path.dirname(dir)) !== ".pi-workflow") throw new Error("Invalid run definition scope.");
 for (let current = path.resolve(dir);; current = path.dirname(current)) {
  try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Symlink run storage is not supported."); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (path.dirname(current) === current) break;
 }
 return path.join(dir, `${id}.definition.js`);
}
function readRegular(file: string, limit: number): string {
 const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
 try {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.size > limit) throw new Error("Run definition exceeds the preview limit or is not a regular file.");
  const bytes = Buffer.alloc(stat.size + 1); const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
  if (count > stat.size) throw new Error("Run definition changed while reading.");
  return bytes.subarray(0, count).toString("utf8");
 } finally { fs.closeSync(fd); }
}
export function writeRunDefinition(dir: string, id: string, source: string): void {
 const target = file(dir, id);
 if (Buffer.byteLength(source) > MAX_BYTES) throw new Error("Run definition exceeds the 2 MiB snapshot limit.");
 fs.mkdirSync(dir, {recursive: true});
 const temporary = `${target}.${randomUUID()}.tmp`;
 try {
  fs.writeFileSync(temporary, source, {flag: "wx", mode: 0o600});
  try { fs.linkSync(temporary, target); } // Atomic publish without overwriting an earlier definition.
  catch (error) {
   if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
   if (readRegular(target, MAX_BYTES) !== source) throw new Error("Run definition differs from the existing snapshot.");
  }
 } finally { fs.rmSync(temporary, {force: true}); }
}
export function readRunDefinition(dir: string, id: string): {script: string; cwd: string} | undefined {
 try {
  const target = file(dir, id);
  const script = readRegular(target, MAX_BYTES);
  const journal = readRegular(path.join(dir, `${id}.jsonl`), 64 * 1024 * 1024);
  const header = journal.split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return undefined; } }).find(row => row?.type === "graph_run");
  if (!header || header.scriptHash !== hash(script)) return undefined;
  return {script, cwd: path.resolve(dir, "../..")};
 } catch { return undefined; }
}
