import { readFile } from 'node:fs/promises';

import type { Mermaid } from 'mermaid';
import type { Browser, BrowserContextOptions, LaunchOptions } from 'playwright-core';
import { chromium } from 'playwright-core';

import {
  BASE_CHROMIUM_ARGS,
  closeQuietly,
  DEAD_PROXY,
  SIGNALS_LEFT_TO_SERVER,
} from './chromium-launch.js';

// Draws Mermaid diagrams for gallery previews (see
// docs/decisions/0010-thumbnail-mermaid-renderer.md). Artifact pages render
// with scripts off, so a mermaid fence there would show as its source; this
// draws the fences' text separately, in a browser that runs scripts but has
// no network at all, and playwright-renderer.ts swaps the SVGs into the
// preview before its screenshot.
//
// The page holds Mermaid's single-file bundle and nothing else. Diagram text
// enters only as an argument to Muninn's own evaluate call: Muninn never
// inserts it as markup, and Mermaid parses it and sanitizes its labels under
// `securityLevel: 'strict'`. The network isolation does not depend on Mermaid
// being free of bugs; see mermaidLaunchOptions and MERMAID_CONTEXT_OPTIONS.
export type MermaidRenderer = {
  close: () => Promise<void>;
  // One SVG per diagram text, in order. An entry is null where Mermaid could
  // not draw that text, and every entry is null while Mermaid rendering is
  // disabled (the bundle or Chromium is missing; reported once). Rejects when
  // the signal aborts, and when the drawing itself fails.
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

// The page the bundle runs in. The context's request filter answers this one
// URL from memory and aborts every other request, so nothing is fetched. The
// page has a real origin rather than about:blank because Chromium crashes
// when a sandboxed srcdoc frame is added to a blank page.
const PAGE_URL = 'http://mermaid.invalid/';
const PAGE_HTML = '<!doctype html><html><body></body></html>';

// The first network layer, fixed at launch for every frame and process the
// browser ever starts, including a sandboxed frame or popup in a process of
// its own.
export function mermaidLaunchOptions(executablePath: string | undefined): LaunchOptions {
  return {
    args: [
      ...BASE_CHROMIUM_ARGS,
      // WebRTC ignores the proxy by default and sends UDP straight out; this
      // restricts it to proxied connections, which all fail. Each Chromium
      // build honors one spelling and ignores the other: full Chromium
      // (CI, desktops) reads --webrtc-ip-handling-policy, and
      // chromium-headless-shell (the Docker image) reads the content-shell
      // --force-webrtc-ip-handling-policy. Both are passed.
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      // No name resolves. WebRTC resolves a TURN-over-TCP server's hostname
      // through the host's resolver even with every connection proxied,
      // which would let a script beacon or exfiltrate through DNS queries.
      // The proxy is an IP literal and the page is answered from memory, so
      // nothing here needs a name.
      '--host-resolver-rules=MAP * ~NOTFOUND',
      // This browser runs script fed by artifact text without Chromium's own
      // sandbox (see BASE_CHROMIUM_ARGS); the interpreter alone leaves a
      // smaller surface for an engine exploit than the JIT compilers, and
      // diagrams draw as fast without them.
      '--js-flags=--jitless',
    ],
    // `<-loopback>` removes Chromium's implicit "never proxy loopback" rule,
    // and nothing else bypasses: every address goes to the dead proxy,
    // including this server's own.
    proxy: { bypass: '<-loopback>', server: DEAD_PROXY },
    ...(executablePath === undefined ? {} : { executablePath }),
    ...SIGNALS_LEFT_TO_SERVER,
  };
}

// The second network layer, per render: offline, no service workers, and a
// request filter (installed in `draw`) that aborts everything but PAGE_URL.
export const MERMAID_CONTEXT_OPTIONS = {
  acceptDownloads: false,
  offline: true,
  serviceWorkers: 'block',
} as const satisfies BrowserContextOptions;

function defaultReport(message: string): void {
  process.stderr.write(`${message}\n`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Settles as `promise` does, or rejects as soon as `signal` aborts.
async function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  signal.throwIfAborted();
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const onAbort = (): void => {
    reject(signal.reason);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
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

  async function launch(): Promise<Browser> {
    const launched = await chromium.launch(mermaidLaunchOptions(executablePath));
    launched.on('disconnected', () => {
      browser = undefined;
    });
    return launched;
  }

  function disable(reason: string): void {
    if (!disabled) {
      disabled = true;
      report(`Mermaid thumbnails disabled, ${reason}`);
    }
  }

  // The bundle and the browser, or null once either is known to be missing
  // or unusable. A launch still in progress when the signal aborts goes on
  // in the background, and the next render uses it.
  async function ready(
    signal: AbortSignal | undefined,
  ): Promise<{ browser: Browser; script: string } | null> {
    if (disabled) {
      return null;
    }
    let script: string;
    try {
      bundle ??= readFile(scriptPath, 'utf8');
      script = await bundle;
    } catch (error) {
      disable(describe(error));
      return null;
    }
    if (script.trim() === '') {
      disable(`the bundle ${scriptPath} is empty`);
      return null;
    }
    const launching = (browser ??= launch());
    try {
      return { browser: await untilAborted(launching, signal), script };
    } catch (error) {
      if (signal?.aborted === true) {
        throw error;
      }
      browser = undefined;
      disable(describe(error));
      return null;
    }
  }

  async function draw(
    launched: Browser,
    script: string,
    texts: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<(string | null)[] | null> {
    const context = await launched.newContext(MERMAID_CONTEXT_OPTIONS);
    // Closing the context makes whatever step is in flight reject. A signal
    // that aborted before the listener was added never calls it, so that
    // case closes the context straight away.
    const abort = (): void => {
      void closeQuietly(context);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted === true) {
      abort();
    }
    try {
      await context.route('**/*', (route) =>
        route.request().url() === PAGE_URL
          ? route.fulfill({ body: PAGE_HTML, contentType: 'text/html' })
          : route.abort('blockedbyclient'),
      );
      const page = await context.newPage();
      await page.goto(PAGE_URL);
      await page.addScriptTag({ content: script });
      return await page.evaluate(
        async ({ prefix, diagrams }) => {
          // Set by the bundle above; the page holds nothing else.
          const mermaid: Mermaid | undefined = Reflect.get(globalThis, 'mermaid');
          if (typeof mermaid?.render !== 'function') {
            return null;
          }
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
      const resources = await ready(signal);
      if (resources === null) {
        return texts.map(() => null);
      }
      const drawings = await draw(resources.browser, resources.script, texts, signal);
      if (drawings === null) {
        disable(`the bundle ${scriptPath} does not define mermaid`);
        return texts.map(() => null);
      }
      return drawings;
    },
  };
}
