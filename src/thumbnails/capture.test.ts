import type { Browser } from 'playwright-core';
import { describe, expect, it, vi } from 'vite-plus/test';

import { captureThumbnail } from './capture.js';
import type { ThumbnailTarget } from './types.js';

const TARGET: ThumbnailTarget = {
  id: 'a1',
  mediaType: 'text/html',
  url: 'https://render.example/a/a1',
};

// How a context's close() behaves: settles, rejects, or never settles.
type CloseBehaviour = 'closes' | 'fails' | 'hangs';

// A browser that draws every page, or fails every navigation, and how many
// of its contexts were closed.
function drawingBrowser(
  closing: CloseBehaviour = 'closes',
  { navigation }: { navigation: 'fails' | 'loads' } = { navigation: 'loads' },
): {
  browser: Browser;
  contextCloses: () => number;
} {
  let closes = 0;
  const browser = {
    newContext: async () => ({
      close: async () => {
        closes += 1;
        if (closing === 'fails') {
          throw new Error('browserContext.close: Target closed');
        }
        if (closing === 'hangs') {
          await Promise.withResolvers<void>().promise;
        }
      },
      newPage: async () => {
        const listeners: ((response: unknown) => void)[] = [];
        return {
          goto: async (url: string) => {
            if (navigation === 'fails') {
              throw new Error('page.goto: net::ERR_CONNECTION_REFUSED');
            }
            for (const listener of listeners) {
              listener({ ok: () => true, url: () => new URL(url).href });
            }
          },
          on: (_event: string, listener: (response: unknown) => void) => {
            listeners.push(listener);
          },
          screenshot: async () => Uint8Array.of(255, 216, 255),
          setDefaultTimeout: () => {},
        };
      },
      route: async () => {},
    }),
  };
  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a partial fake of Playwright's Browser
    browser: browser as unknown as Browser,
    contextCloses: () => closes,
  };
}

const throwingHooks = {
  missed: vi.fn(),
  rendered: () => {
    throw new Error('rendered hook failed');
  },
};

describe('captureThumbnail', () => {
  it.each<CloseBehaviour>(['fails', 'hangs'])(
    'returns the preview of a render that finishes when closing its context %s',
    async (closing) => {
      const { browser, contextCloses } = drawingBrowser(closing);

      const bytes = await captureThumbnail(
        browser,
        TARGET,
        { report: () => {}, timeoutMs: 1000 },
        { missed: vi.fn(), rendered: () => {} },
      );

      expect(bytes).toEqual(Uint8Array.of(255, 216, 255));
      expect(contextCloses()).toBe(1);
    },
  );

  it("closes the render's context after a render that finishes", async () => {
    const { browser, contextCloses } = drawingBrowser();

    await captureThumbnail(
      browser,
      TARGET,
      { report: () => {}, timeoutMs: 1000 },
      { missed: vi.fn(), rendered: () => {} },
    );

    expect(contextCloses()).toBe(1);
  });

  it.each<CloseBehaviour>(['closes', 'fails', 'hangs'])(
    "reports a failed render's own error and closes its context when the close %s",
    async (closing) => {
      const { browser, contextCloses } = drawingBrowser(closing, { navigation: 'fails' });
      const hooks = { missed: vi.fn(), rendered: vi.fn() };

      await expect(
        captureThumbnail(browser, TARGET, { report: () => {}, timeoutMs: 1000 }, hooks),
      ).rejects.toThrow('net::ERR_CONNECTION_REFUSED');
      expect(contextCloses()).toBe(1);
      expect(hooks.missed).not.toHaveBeenCalled();
    },
  );

  it("reports the rendered hook's failure when closing the context fails too", async () => {
    const { browser } = drawingBrowser('fails');

    await expect(
      captureThumbnail(browser, TARGET, { report: () => {}, timeoutMs: 1000 }, throwingHooks),
    ).rejects.toThrow('rendered hook failed');
  });

  it("reports the rendered hook's failure without waiting for a close that never settles", async () => {
    const { browser, contextCloses } = drawingBrowser('hangs');

    await expect(
      captureThumbnail(browser, TARGET, { report: () => {}, timeoutMs: 1000 }, throwingHooks),
    ).rejects.toThrow('rendered hook failed');
    expect(contextCloses()).toBe(1);
  });

  it("closes the render's context even when the runtime's rendered hook throws", async () => {
    const { browser, contextCloses } = drawingBrowser();

    await expect(
      captureThumbnail(
        browser,
        TARGET,
        { report: () => {}, timeoutMs: 1000 },
        {
          missed: vi.fn(),
          rendered: () => {
            throw new Error('rendered hook failed');
          },
        },
      ),
    ).rejects.toThrow('rendered hook failed');

    expect(contextCloses()).toBe(1);
  });
});
