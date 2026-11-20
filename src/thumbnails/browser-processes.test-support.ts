import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Browser } from 'playwright-core';

import { browserProcessId } from './chromium-launch.js';

// Process helpers for the renderer tests. The group lookup goes through `ps`,
// independent of the renderer's own, so a wrong lookup there cannot also
// blind the tests.

export async function browserPid(browser: Browser): Promise<number> {
  const pid = await browserProcessId(browser);
  if (pid === undefined) {
    throw new Error('Chromium reported no browser process');
  }
  return pid;
}

export async function processGroupByPs(pid: number): Promise<number> {
  const { stdout } = await promisify(execFile)('ps', ['-o', 'pgid=', '-p', String(pid)]);
  return Number(stdout.trim());
}

// True while any process of the group remains, zombies included.
export function groupRemains(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
}

// Ends whatever a failed test left behind, stopped processes included.
export function killGroup(group: number | undefined): void {
  try {
    if (group !== undefined) {
      process.kill(-group, 'SIGKILL');
    }
  } catch {
    // Already gone.
  }
}
