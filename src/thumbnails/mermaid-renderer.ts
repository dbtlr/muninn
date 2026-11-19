import { readFile } from 'node:fs/promises';

import type { Mermaid } from 'mermaid';
import type { Browser, BrowserContext } from 'playwright-core';
import { chromium } from 'playwright-core';

import { BASE_CHROMIUM_ARGS, DEAD_PROXY, SIGNALS_LEFT_TO_SERVER } from './chromium-launch.js';

// Draws Mermaid diagrams for gallery previews (see
// docs/decisions/0010-thumbnail-mermaid-renderer.md). Artifact pages render
// with scripts off, so a mermaid fence there would show as its source; this
// draws the fences' text separately, in a browser that runs scripts but has
// no network at all, and playwright-renderer.ts swaps the SVGs into the
// preview before its screenshot.
//
// The page holds Mermaid's single-file bundle and nothing else. Diagram text
// enters only as an argument to Muninn's own evaluate call, so it reaches
// Mermaid as a string and is never parsed as HTML. The isolation does not
// depend on Mermaid being free of bugs: the browser is launched with a proxy
// nobody listens on and no bypass, not even loopback, so every connection
// its network stack makes fails; WebRTC may only use the proxy, so it has no
// UDP path either; and each context is offline with every request aborted.
export type MermaidRenderer = {
  close: () => Promise<void>;
  // One SVG per diagram text, in order. An entry is null where Mermaid could
  // not draw that text, and every entry is null while Mermaid rendering is
  // disabled (the bundle or Chromium is missing; reported once). Rejects when
  // the signal aborts mid-render.
  render: (texts: readonly string[], signal?: AbortSignal) => Promise<(string | null)[]>;
};

type MermaidRendererOptions = {
  executablePath?: string | undefined;
  report?: (message: string) => void;
  // Mermaid's single-file IIFE bundle (mermaid/dist/mermaid.min.js), which
  // defines globalThis.mermaid. The site's own /assets/mermaid.js loads
  // diagram code in chunks over the network, so it cannot run here.
  scriptPath: string;
};

// Each SVG is drawn with this id prefix plus its index; the id scopes the
// SVG's own styles, so it must not collide with an id on the preview page.
const DIAGRAM_ID_PREFIX = 'thumbnail-diagram-';

function defaultReport(message: string): void {
  process.stderr.write(`${message}\n`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function closeQuietly(context: BrowserContext): Promise<void> {
  try {
    await context.close();
  } catch {
    // Already closed; nothing to do.
  }
}

// One headless Chromium for Mermaid alone, launched on first use and
// relaunched after a crash. It never shares a process with an artifact page:
// the artifact browser disables scripts for its whole life, and this one
// never loads anything an artifact supplies except diagram text as data.
export function createMermaidRenderer({
  executablePath,
  report = defaultReport,
  scriptPath,
}: MermaidRendererOptions): MermaidRenderer {
  let bundle: Promise<string> | undefined;
  let browser: Promise<Browser> | undefined;
  let disabled = false;

  function disable(reason: string): void {
    disabled = true;
    report(`Mermaid thumbnails disabled, ${reason}`);
  }

  async function launch(): Promise<Browser> {
    const launched = await chromium.launch({
      args: [
        ...BASE_CHROMIUM_ARGS,
        // WebRTC ignores the proxy by default and sends UDP straight out;
        // this restricts it to proxied connections, which all fail. It is a
        // launch switch, so it holds in every frame and process, including
        // a sandboxed frame or popup in a process of its own. (Chromium
        // ignores the content-shell spelling, --force-webrtc-ip-handling-policy.)
        '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      ],
      // `<-loopback>` removes Chromium's implicit "never proxy loopback"
      // rule, and nothing else bypasses: every address goes to the dead
      // proxy, including this server's own.
      proxy: { bypass: '<-loopback>', server: DEAD_PROXY },
      ...(executablePath === undefined ? {} : { executablePath }),
      ...SIGNALS_LEFT_TO_SERVER,
    });
    launched.on('disconnected', () => {
      browser = undefined;
    });
    return launched;
  }

  // The bundle and the browser, or null once either is known to be missing.
  async function ready(): Promise<{ browser: Browser; script: string } | null> {
    if (disabled) {
      return null;
    }
    try {
      bundle ??= readFile(scriptPath, 'utf8');
      const script = await bundle;
      browser ??= launch();
      return { browser: await browser, script };
    } catch (error) {
      browser = undefined;
      if (!disabled) {
        disable(describe(error));
      }
      return null;
    }
  }

  async function draw(
    launched: Browser,
    script: string,
    texts: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<(string | null)[]> {
    signal?.throwIfAborted();
    const context = await launched.newContext({
      acceptDownloads: false,
      offline: true,
      serviceWorkers: 'block',
    });
    // Closing the context makes whatever step is in flight reject.
    const abort = (): void => {
      void closeQuietly(context);
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await context.route('**/*', (route) => route.abort('blockedbyclient'));
      const page = await context.newPage();
      await page.setContent('<!doctype html><html><body></body></html>');
      await page.addScriptTag({ content: script });
      return await page.evaluate(
        async ({ prefix, diagrams }) => {
          // Set by the bundle above; the page holds nothing else.
          const mermaid: Mermaid = Reflect.get(globalThis, 'mermaid');
          mermaid.initialize({ securityLevel: 'strict', startOnLoad: false, theme: 'dark' });
          return Promise.all(
            diagrams.map(async (text, index) => {
              try {
                return (await mermaid.render(`${prefix}${String(index)}`, text)).svg;
              } catch {
                return null;
              }
            }),
          );
        },
        { diagrams: [...texts], prefix: DIAGRAM_ID_PREFIX },
      );
    } finally {
      signal?.removeEventListener('abort', abort);
      await closeQuietly(context);
    }
  }

  return {
    close: async () => {
      const current = browser;
      browser = undefined;
      // A launch that failed was already reported; there is nothing to close.
      const launched = await current?.catch(() => undefined);
      await launched?.close();
    },
    render: async (texts, signal) => {
      const resources = await ready();
      if (resources === null) {
        return texts.map(() => null);
      }
      return draw(resources.browser, resources.script, texts, signal);
    },
  };
}
