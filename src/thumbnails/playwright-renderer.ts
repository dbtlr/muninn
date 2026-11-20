import { access } from 'node:fs/promises';

import type { Browser } from 'playwright-core';
import { chromium } from 'playwright-core';

import { captureThumbnail } from './capture.js';
import {
  BASE_CHROMIUM_ARGS,
  createBrowserSlot,
  DEAD_PROXY,
  LAUNCH_TIMEOUT_MS,
  SIGNALS_LEFT_TO_SERVER,
} from './chromium-launch.js';
import { createMermaidRenderer } from './mermaid-renderer.js';
import type { ThumbnailRenderer, ThumbnailTarget } from './types.js';

// Where a Chromium may already be, when MUNINN_CHROMIUM_PATH is not set:
// Debian's `chromium-headless-shell` package (the Docker image), the
// `chromium` packages of Linux distributions, Chrome, and macOS. Any hit is
// fine; playwright-core drives it over CDP.
const CHROMIUM_CANDIDATES = [
  '/usr/bin/chromium-headless-shell',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveChromiumPath(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const override = env.MUNINN_CHROMIUM_PATH?.trim();
  if (override !== undefined && override !== '') {
    return override;
  }
  const found = await Promise.all(CHROMIUM_CANDIDATES.map(exists));
  return CHROMIUM_CANDIDATES.find((_, index) => found[index]);
}

type RendererOptions = {
  executablePath?: string | undefined;
  // Mermaid's single-file bundle, for drawing a Markdown artifact's mermaid
  // fences into its preview (see mermaid-renderer.ts). Without it, or when
  // the file is missing, a fence shows as its source.
  mermaidScriptPath?: string | undefined;
  // This instance's public base URL (MUNINN_PUBLIC_BASE_URL). Artifacts
  // embed each other by the full URL add_artifact returns; a render loads
  // those from its own origin instead (see capture.ts).
  publicBaseUrl?: string | undefined;
  report?: (message: string) => void;
  // Upper bound for one whole render, from creating its context to the
  // screenshot; a render still busy at the deadline fails (see
  // captureThumbnail).
  timeoutMs?: number;
};

function defaultReport(message: string): void {
  process.stderr.write(`${message}\n`);
}

// The launch fence capture.ts relies on, for Node: the browser is launched
// with a proxy nobody listens on and a bypass list naming only the server's
// own host and port, so every connection the network stack makes, from any
// page or frame, dies at the proxy unless it goes to this server. capture.ts
// narrows that one origin to GETs.
export function proxyFencedTo(origin: string): { bypass: string; server: string } {
  // `<-loopback>` removes Chromium's implicit "never proxy loopback" rule,
  // so 127.0.0.1 on any other port goes to the dead proxy like everything
  // else; the one host:port bypass is this server. The port is always
  // spelled out: URL.host drops a default port, and a bare hostname in a
  // bypass rule matches every port on it.
  const url = new URL(origin);
  const defaultPort = url.protocol === 'https:' ? '443' : '80';
  const port = url.port === '' ? defaultPort : url.port;
  return { bypass: `<-loopback>,${url.hostname}:${port}`, server: DEAD_PROXY };
}

// One shared headless Chromium, launched on first use and replaced after a
// crash or once it stops answering (see createBrowserSlot). Each render gets
// its own short-lived context, so no cookies, cache, or storage carry over
// from one artifact to the next. A first launch that fails (no Chromium on
// this machine) is reported once; after that every render declines with null
// and the gallery keeps its drawn placeholders. A relaunch that fails after a
// browser has run is reported and declines that render only; the next render
// launches again.
export function createPlaywrightRenderer({
  executablePath,
  mermaidScriptPath,
  publicBaseUrl,
  report = defaultReport,
  timeoutMs = 15_000,
}: RendererOptions = {}): ThumbnailRenderer {
  let disabled = false;
  let launchedOnce = false;
  // The proxy fence is a launch option, so the browser is pinned to the
  // first origin it renders; every artifact URL comes from the same
  // server, so a second origin is a caller bug, not a case to support.
  let pinnedOrigin: string | undefined;
  const mermaid =
    mermaidScriptPath === undefined
      ? undefined
      : createMermaidRenderer({ executablePath, report, scriptPath: mermaidScriptPath });

  async function launch(): Promise<Browser> {
    if (pinnedOrigin === undefined) {
      throw new Error('Thumbnail renderer launched before its origin was pinned');
    }
    try {
      const launched = await chromium.launch({
        args: [
          ...BASE_CHROMIUM_ARGS,
          // Scripting off in every renderer process from the moment it
          // starts. The per-context `javaScriptEnabled: false` is applied
          // over CDP after a frame exists, which a sandboxed srcdoc frame in
          // its own process can beat; a startup setting cannot be raced.
          // Playwright passes its own --blink-settings (hover/pointer
          // hints) and appends user args after its own, and Chromium keeps
          // the last copy of a repeated switch, so this one wins. The
          // renderer test's zero-datagram assertion is what would notice if
          // that ordering ever changed.
          '--blink-settings=scriptEnabled=false',
        ],
        proxy: proxyFencedTo(pinnedOrigin),
        timeout: LAUNCH_TIMEOUT_MS,
        ...(executablePath === undefined ? {} : { executablePath }),
        ...SIGNALS_LEFT_TO_SERVER,
      });
      launchedOnce = true;
      return launched;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (launchedOnce) {
        report(`Thumbnail render declined, Chromium failed to relaunch: ${message}`);
      } else {
        disabled = true;
        report(`Thumbnail rendering disabled, Chromium failed to launch: ${message}`);
      }
      throw error;
    }
  }
  const slot = createBrowserSlot(launch);

  async function currentBrowser(origin: string): Promise<Browser | null> {
    pinnedOrigin ??= origin;
    if (origin !== pinnedOrigin) {
      throw new Error(`Thumbnail renderer is pinned to ${pinnedOrigin}, cannot render ${origin}`);
    }
    try {
      return await slot.acquire();
    } catch {
      // Already reported by launch(); the caller declines quietly.
      return null;
    }
  }

  async function render(target: ThumbnailTarget): Promise<Uint8Array | null> {
    // Headless Chromium downloads a PDF instead of drawing it.
    if (disabled || target.mediaType === 'application/pdf') {
      return null;
    }
    const launched = await currentBrowser(new URL(target.url).origin);
    if (launched === null) {
      return null;
    }
    return captureThumbnail(
      launched,
      target,
      { mermaid, publicBaseUrl, report, timeoutMs },
      {
        missed: () => {
          slot.missed(launched);
        },
        rendered: () => {
          slot.rendered(launched);
        },
      },
    );
  }

  return {
    close: async () => {
      await Promise.all([mermaid?.close(), slot.close()]);
    },
    render,
  };
}
