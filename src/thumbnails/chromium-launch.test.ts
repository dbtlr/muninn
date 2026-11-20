import type { Browser } from 'playwright-core';
import { chromium } from 'playwright-core';
import { describe, expect, it } from 'vite-plus/test';

import {
  browserPid,
  groupRemains,
  killGroup,
  processGroupByPs,
} from './browser-processes.test-support.js';
import {
  BASE_CHROMIUM_ARGS,
  createBrowserSlot,
  processGroupOf,
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

describe('processGroupOf', () => {
  // macOS has no /proc; there the browser process leads its own group.
  it.skipIf(process.platform !== 'linux')(
    "finds this process's group as ps reports it",
    async () => {
      await expect(processGroupOf(process.pid)).resolves.toBe(await processGroupByPs(process.pid));
    },
  );
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
