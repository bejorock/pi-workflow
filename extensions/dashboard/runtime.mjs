/** Resolve host-provided Pi peers outside Pi's extension loader.
 * Managed git/npm installs intentionally have no physical copies of these peers.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const PEERS = new Set(['@earendil-works/pi-tui', '@earendil-works/pi-coding-agent']);
export function resolveRuntimePeer(name, root = process.env.PI_CODING_AGENT_PACKAGE_ROOT) {
  if (!PEERS.has(name)) throw new Error(`Unsupported dashboard runtime package: ${name}`);
  const roots = root ? [pathToFileURL(path.join(root, 'package.json')), import.meta.url] : [import.meta.url];
  for (const base of roots) {
    const require = createRequire(base);
    try { return require.resolve(name); } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
    }
    // coding-agent is import-only: require.resolve cannot select its export.
    // Resolve the declared import entry from the same Node lookup roots.
    const candidates = [...(root ? [root] : []), ...(require.resolve.paths(name) ?? []).map(dir => path.join(dir, name))];
    for (const directory of candidates) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
        if (pkg.name !== name) continue;
        const exports = pkg.exports?.['.'];
        const entry = typeof exports === 'string' ? exports : exports?.import ?? pkg.main;
        if (typeof entry === 'string') {
          const file = path.resolve(directory, entry);
          if (fs.statSync(file).isFile()) return file;
        }
      } catch { /* Try the next installation lookup root. */ }
    }
  }
  throw new Error(`Cannot resolve ${name} for the standalone dashboard. Open it using /workspace-dashboard in Pi so the host package location is supplied. If this persists, update pi-workflow and restart Pi.`);
}
export async function loadRuntimePeer(name) {
  return import(pathToFileURL(resolveRuntimePeer(name)).href);
}
