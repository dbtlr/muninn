import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import type { Browser } from 'playwright-core';
import { chromium } from 'playwright-core';
import { describe, expect, it, vi } from 'vite-plus/test';

import {
  browserPid,
  groupRemains,
  killGroup,
  processGroupByPs,
} from './browser-processes.test-support.js';
import {
  BASE_CHROMIUM_ARGS,
  createBrowserSlot,
  ownedProcessGroup,
  SIGNALS_LEFT_TO_SERVER,
  untilAborted,
} from './chromium-launch.js';
import { resolveChromiumPath } from './playwright-renderer.js';

describe('untilAborted', () => {
  it('settles as the promise does while the signal stays quiet', async () => {
    await expect(
      untilAborted(Promise.resolve('drawn'), new AbortController().signal),
    ).resolves.toBe('drawn');
    await expect(untilAborted(Promise.reject(new Error('crashed')), undefined)).rejects.toThrow(
      'crashed',
    );
  });

  it('rejects as soon as the signal aborts, without waiting for the promise', async () => {
    const never = Promise.withResolvers<string>().promise;
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 50);

    await expect(untilAborted(never, controller.signal)).rejects.toThrow(/aborted/u);
    await expect(untilAborted(never, AbortSignal.abort())).rejects.toThrow(/aborted/u);
  });
});

const chromiumPath = await resolveChromiumPath(process.env);

const LAUNCH_OPTIONS = {
  args: BASE_CHROMIUM_ARGS,
  executablePath: chromiumPath,
  ...SIGNALS_LEFT_TO_SERVER,
};

async function draws(browser: Browser): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.setContent('<p>drawn</p>');
    await expect(page.textContent('p')).resolves.toBe('drawn');
  } finally {
    await context.close();
  }
}

// Linux answers from /proc; macOS, which has no /proc, asks ps. Process
// groups and ps are POSIX only.
describe.skipIf(process.platform === 'win32')('ownedProcessGroup', () => {
  it('finds the group of a process this server started as a group leader', async () => {
    // Started the way Playwright starts Chromium: detached, leading a group.
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    try {
      const pid = child.pid ?? 0;

      await expect(ownedProcessGroup(pid)).resolves.toBe(await processGroupByPs(pid));
      await expect(processGroupByPs(pid)).resolves.toBe(pid);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('refuses a group whose leader this server did not start', async () => {
    // This process's own group is led by whatever started the test run.
    await expect(ownedProcessGroup(process.pid)).resolves.toBeUndefined();
  });

  it('refuses a process that does not exist', async () => {
    const child = spawn('true', [], { detached: true, stdio: 'ignore' });
    await once(child, 'exit');

    await expect(ownedProcessGroup(child.pid ?? 0)).resolves.toBeUndefined();
  });
});

describe.skipIf(chromiumPath === undefined)('createBrowserSlot', { timeout: 60_000 }, () => {
  it('replaces a browser that stops responding after three missed deadlines and ends its processes', async () => {
    const slot = createBrowserSlot(async () => chromium.launch(LAUNCH_OPTIONS));
    let group: number | undefined;
    try {
      const stuck = await slot.acquire();
      const pid = await browserPid(stuck);
      group = await processGroupByPs(pid);
      // Stopped, it keeps its connection open but never answers, and
      // Playwright's own close waits for it forever.
      process.kill(pid, 'SIGSTOP');

      slot.missed(stuck);
      slot.missed(stuck);
      await expect(slot.acquire()).resolves.toBe(stuck);
      slot.missed(stuck);
      const fresh = await slot.acquire();

      expect(fresh).not.toBe(stuck);
      await expect.poll(() => groupRemains(group ?? 0), { timeout: 10_000 }).toBe(false);
      await draws(fresh);
      // Late reports about the replaced browser count against nothing.
      slot.missed(stuck);
      slot.missed(stuck);
      slot.missed(stuck);
      await expect(slot.acquire()).resolves.toBe(fresh);
    } finally {
      killGroup(group);
      await slot.close();
    }
  });

  it('signals no local process group for a browser Playwright reached remotely', async () => {
    // With SELENIUM_REMOTE_URL set, Playwright drives a browser on another
    // machine, and the process id it reports names nothing of ours. The
    // variable is set only once the local stand-in has launched.
    const slot = createBrowserSlot(async () => {
      const browser = await chromium.launch(LAUNCH_OPTIONS);
      vi.stubEnv('SELENIUM_REMOTE_URL', 'http://grid.invalid:4444/wd/hub');
      return browser;
    });
    let group: number | undefined;
    try {
      const remote = await slot.acquire();
      const pid = await browserPid(remote);
      group = await processGroupByPs(pid);
      process.kill(pid, 'SIGSTOP');

      slot.missed(remote);
      slot.missed(remote);
      slot.missed(remote);

      // Replaced, but left alone: its group is still there.
      vi.unstubAllEnvs();
      await expect(slot.acquire()).resolves.not.toBe(remote);
      await delay(1000);
      expect(groupRemains(group)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      killGroup(group);
      await slot.close();
    }
  });

  it('keeps a browser whose render finished between missed deadlines', async () => {
    const slot = createBrowserSlot(async () => chromium.launch(LAUNCH_OPTIONS));
    try {
      const browser = await slot.acquire();

      slot.missed(browser);
      slot.missed(browser);
      slot.rendered(browser);
      slot.missed(browser);
      slot.missed(browser);

      await expect(slot.acquire()).resolves.toBe(browser);
    } finally {
      await slot.close();
    }
  });

  it('ends every process of a browser that crashed, and launches a new one', async () => {
    const slot = createBrowserSlot(async () => chromium.launch(LAUNCH_OPTIONS));
    let group: number | undefined;
    try {
      const crashed = await slot.acquire();
      const pid = await browserPid(crashed);
      group = await processGroupByPs(pid);
      process.kill(pid, 'SIGKILL');

      await expect.poll(() => crashed.isConnected(), { timeout: 10_000 }).toBe(false);

      await expect.poll(() => groupRemains(group ?? 0), { timeout: 10_000 }).toBe(false);
      const fresh = await slot.acquire();
      expect(fresh).not.toBe(crashed);
      await draws(fresh);
    } finally {
      killGroup(group);
      await slot.close();
    }
  });

  it('ends every process of its browser when it closes', async () => {
    const slot = createBrowserSlot(async () => chromium.launch(LAUNCH_OPTIONS));
    const group = await processGroupByPs(await browserPid(await slot.acquire()));

    await slot.close();

    await expect.poll(() => groupRemains(group), { timeout: 10_000 }).toBe(false);
  });

  it('ends every process of a stopped browser when it closes, without waiting for it', async () => {
    const slot = createBrowserSlot(async () => chromium.launch(LAUNCH_OPTIONS));
    let group: number | undefined;
    try {
      const pid = await browserPid(await slot.acquire());
      group = await processGroupByPs(pid);
      // Stopped, it never acts on Playwright's close request.
      process.kill(pid, 'SIGSTOP');

      await expect(untilAborted(slot.close(), AbortSignal.timeout(5000))).resolves.toBeUndefined();

      await expect.poll(() => groupRemains(group ?? 0), { timeout: 10_000 }).toBe(false);
    } finally {
      killGroup(group);
    }
  });

  it('launches a new browser after one that died during its launch', async () => {
    let attempts = 0;
    let group: number | undefined;
    const slot = createBrowserSlot(async () => {
      attempts += 1;
      const browser = await chromium.launch(LAUNCH_OPTIONS);
      if (attempts === 1) {
        const pid = await browserPid(browser);
        group = await processGroupByPs(pid);
        const disconnected = Promise.withResolvers<unknown>();
        browser.once('disconnected', disconnected.resolve);
        process.kill(pid, 'SIGKILL');
        await disconnected.promise;
      }
      return browser;
    });
    try {
      // The render that launched it may get the dead browser; the next one
      // must not.
      const dead = await slot.acquire();
      const fresh = await slot.acquire();

      expect(fresh).not.toBe(dead);
      expect(fresh.isConnected()).toBe(true);
      await draws(fresh);
    } finally {
      killGroup(group);
      await slot.close();
    }
  });

  it('launches again after a launch fails', async () => {
    let attempts = 0;
    const slot = createBrowserSlot(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('no Chromium');
      }
      return chromium.launch(LAUNCH_OPTIONS);
    });
    try {
      await expect(slot.acquire()).rejects.toThrow('no Chromium');
      await draws(await slot.acquire());
    } finally {
      await slot.close();
    }
  });
});
