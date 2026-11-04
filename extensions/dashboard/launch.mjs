#!/usr/bin/env node
/** Minimal launcher: catch module-link failures before viewer.mjs executes.
 * Only Node built-ins here so missing peer dependencies remain visible in Herdr.
 */
import { pathToFileURL } from 'node:url';

export async function launch(args = process.argv.slice(2)) {
  let raw;
  try {
    const i = args.indexOf('--snapshot');
    if (i < 0 || !args[i+1]) throw new Error('Usage: launch.mjs --snapshot PATH (opened by /workspace-dashboard)');
    const { runViewer } = await import('./viewer.mjs');
    await runViewer(args[i+1]);
  } catch (error) {
    // The viewer restores terminal state itself. Imports may fail before it ran.
    process.stderr.write(`\nDashboard startup failed: ${String(error?.stack ?? error).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')}\n`);
    process.exitCode = 1;
    if (process.stdin.isTTY && !process.env.PI_DASHBOARD_EXIT_ON_ERROR) {
      process.stderr.write('\nPress q, Enter, or Ctrl-C to close this dashboard tab.\n');
      raw = process.stdin.isRaw;
      process.stdin.setRawMode(true); process.stdin.resume();
      try {
        await new Promise(resolve => {
          const input = data => {
            if (/[qQ\r\n\x03]/.test(data.toString())) { process.stdin.off('data', input); resolve(); }
          };
          process.stdin.on('data', input);
        });
      } finally { process.stdin.setRawMode(!!raw); process.stdin.pause(); }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await launch();
