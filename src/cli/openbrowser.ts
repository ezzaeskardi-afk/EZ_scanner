/**
 * Opening the GUI in the user's own browser.
 *
 * Its own module because the failure mode is worth a test and `main.ts` runs on import: the
 * helper is spawned detached, and on a machine that has no helper the failure arrives
 * asynchronously as an `error` event. With no listener that event is thrown, which took the
 * whole process down — `ezscan gui` printed the URL with the token and then died, leaving a
 * server the user could not reach (headless Linux has no `xdg-open`, and a locked-down Windows
 * box can refuse `cmd`).
 */
import { spawn } from 'node:child_process';

interface OpenBrowserOptions {
  /** The helper to run; defaults to the platform's opener. A test seam. */
  command?: string;
  /** Arguments for the helper; defaults to the platform's opener arguments. A test seam. */
  args?: string[];
}

export function openBrowser(url: string, options: OpenBrowserOptions = {}): void {
  const platform = process.platform;
  const command = options.command ?? (platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open');
  const argv = options.args ?? (platform === 'win32' ? ['/c', 'start', '', url] : [url]);
  try {
    const child = spawn(command, argv, { detached: true, stdio: 'ignore' });
    // A missing helper is a normal thing on a server, not an error to report: the URL is already
    // on screen. The listener is the point — without it this event is thrown and kills the CLI.
    child.on('error', () => {});
    child.unref();
  } catch {
    /* the user can open the URL by hand */
  }
}
