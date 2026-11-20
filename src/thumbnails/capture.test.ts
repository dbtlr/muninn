import type { Browser } from 'playwright-core';
import { describe, expect, it, vi } from 'vite-plus/test';

import { captureThumbnail } from './capture.js';
import type { ThumbnailTarget } from './types.js';

const TARGET: ThumbnailTarget = {
  id: 'a1',
  mediaType: 'text/html',
  url: 'https://render.example/a/a1',
};

// A browser that draws every page, and how many of its contexts were closed.
function drawingBrowser(): { browser: Browser; contextCloses: () => number } {
  let closes = 0;
  const browser = {
    newContext: async () => ({
      close: async () => {
        closes += 1;
      },
      newPage: async () => {
        const listeners: ((response: unknown) => void)[] = [];
        return {
          goto: async (url: string) => {
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

describe('captureThumbnail', () => {
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
