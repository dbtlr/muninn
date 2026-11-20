import { access } from 'node:fs/promises';

import type { Browser, BrowserContext, Page } from 'playwright-core';
import { chromium } from 'playwright-core';

import { mediaDefinition } from '../artifacts/media.js';
import {
  BASE_CHROMIUM_ARGS,
  closeWhenCreated,
  createBrowserSlot,
  DEAD_PROXY,
  ignoreFailure,
  LAUNCH_TIMEOUT_MS,
  SIGNALS_LEFT_TO_SERVER,
  untilAborted,
} from './chromium-launch.js';
import type { MermaidRenderer } from './mermaid-renderer.js';
import { createMermaidRenderer } from './mermaid-renderer.js';
import type { ThumbnailRenderer, ThumbnailTarget } from './types.js';

// Rendered at a desktop width, then captured at half scale: the gallery
// shows a card a few hundred pixels wide, so 640x400 is plenty and keeps
// each JPEG a few tens of kilobytes.
const VIEWPORT = { height: 800, width: 1280 };
const DEVICE_SCALE_FACTOR = 0.5;
const JPEG_QUALITY = 80;

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
  // those from its own origin instead (see confineToOrigin).
  publicBaseUrl?: string | undefined;
  report?: (message: string) => void;
  // Upper bound for one whole render, from opening the page to the
  // screenshot; a page that is still busy at the deadline is closed and the
  // render fails.
  timeoutMs?: number;
};

function defaultReport(message: string): void {
  process.stderr.write(`${message}\n`);
}

// Images get a tiny wrapper page rather than Chromium's bare image viewer, so
// the preview is the picture fitted on black instead of a corner of it.
function imagePage(url: string): string {
  return (
    '<!doctype html><html><body style="margin:0;background:#000;display:grid;place-items:center;height:100vh">' +
    `<img src="${url}" alt="" style="max-width:100%;max-height:100%;object-fit:contain"></body></html>`
  );
}

// A preview is a screenshot of the static document. An artifact's scripts
// run in a viewer's browser inside an opaque-origin sandbox, but a page
// rendered here runs on the server host with nobody watching, and every
// script-driven network path (fetch, WebSocket, WebTransport, WebRTC,
// workers, popups) turned out to need its own fence with its own gaps. So
// the render context has JavaScript off (see `render`), which removes that
// whole class. A Markdown artifact's mermaid fences are drawn in a separate
// browser that runs only Mermaid, with no network at all (see
// mermaid-renderer.ts), and swapped into the page before the screenshot.
//
// What remains is declarative loads (img, iframe, stylesheet, meta refresh),
// fenced twice. The browser is launched (see `launch`) with a proxy nobody
// listens on and a bypass list naming only the server's own host and port,
// so every other connection the network stack makes, from any page or frame,
// dies at the proxy. This request filter then narrows the one allowed origin
// to GETs, which keeps /mcp out of reach even from a form.
//
// A GET under the public base URL names this same server by the address
// visitors use, which the renderer cannot reach. It never goes to the
// network: the filter answers it with a redirect to the same path and query
// on the render origin, so the embed shows and the render still loads only
// from its own origin. Chromium follows that redirect as a GET, which
// Playwright does not route again; its target is the one address the proxy
// fence lets through.
async function confineToOrigin(
  context: BrowserContext,
  origin: string,
  publicBaseUrl: string | undefined,
): Promise<void> {
  await context.route('**/*', (route) => {
    const request = route.request();
    if (request.method() !== 'GET') {
      return route.abort('blockedbyclient');
    }
    if (new URL(request.url()).origin === origin) {
      return route.continue();
    }
    const local =
      publicBaseUrl === undefined
        ? undefined
        : localUrlFor(request.url(), { origin, publicBaseUrl });
    return local === undefined
      ? route.abort('blockedbyclient')
      : route.fulfill({ headers: { Location: local }, status: 302 });
  });
}

// The URL on the render origin for `url`, when `url` is under the public
// base URL: the same path below the base, and the same query. Undefined for
// anything else, including another scheme or port on the public host.
export function localUrlFor(
  url: string,
  { origin, publicBaseUrl }: { origin: string; publicBaseUrl: string },
): string | undefined {
  const base = new URL(publicBaseUrl).href.replace(/\/+$/u, '');
  const { href } = new URL(url);
  return href.startsWith(`${base}/`) ? `${origin}${href.slice(base.length)}` : undefined;
}

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

// Reports whether the artifact's own URL answered with a 2xx, for a page
// or for the <img> in an image wrapper. A refused signed URL (expired, say,
// after a slow browser launch), a removed artifact, or a failed load is
// declined, because the queue would otherwise store the error page as the
// artifact's lasting preview.
function watchArtifactResponse(page: Page, url: string): () => boolean {
  const href = new URL(url).href;
  let loaded = false;
  page.on('response', (response) => {
    if (response.url() === href) {
      loaded = response.ok();
    }
  });
  return () => loaded;
}

// Where a render is, as far as its deadline cares.
type RenderProgress = { drawingDiagrams: boolean };

// Replaces each of a Markdown page's mermaid fences with its drawing. The
// page has scripts off: Playwright reads and writes its DOM from its own
// isolated world, and markup set that way never runs a script. markdown.ts
// emits `<pre class="mermaid">` only for a ```mermaid fence and escapes any
// raw HTML in the source, so every match is a fence and its text content is
// the diagram source. A fence Mermaid cannot draw keeps its source, and so
// does every fence when the drawing fails (reported): the preview is still
// worth keeping. Only the render's deadline fails the render.
//
// `progress.drawingDiagrams` is true exactly while the render waits on the
// Mermaid renderer. It is left set when that wait ends at the deadline, so
// the render can tell the deadline passed there.
async function drawMermaidFences(
  page: Page,
  {
    mermaid,
    progress,
    report,
    signal,
  }: {
    mermaid: MermaidRenderer;
    progress: RenderProgress;
    report: (message: string) => void;
    signal: AbortSignal;
  },
): Promise<void> {
  const fences = page.locator('pre.mermaid');
  const texts = await fences.allTextContents();
  if (texts.length === 0) {
    return;
  }
  let drawings: (string | null)[];
  try {
    progress.drawingDiagrams = true;
    drawings = await mermaid.render(texts, signal);
    progress.drawingDiagrams = false;
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    progress.drawingDiagrams = false;
    report(`Mermaid diagrams left as source in a thumbnail: ${message}`);
    return;
  }
  await fences.evaluateAll((elements, svgs) => {
    elements.forEach((element, index) => {
      const svg = svgs[index];
      if (typeof svg === 'string') {
        element.outerHTML = svg;
      }
    });
  }, drawings);
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

  async function capture(
    context: BrowserContext,
    target: ThumbnailTarget,
    { progress, signal }: { progress: RenderProgress; signal: AbortSignal },
  ): Promise<Uint8Array | null> {
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    const artifactLoaded = watchArtifactResponse(page, target.url);
    if (mediaDefinition(target.mediaType).renderingMode === 'binary') {
      await page.setContent(imagePage(target.url), { waitUntil: 'networkidle' });
    } else {
      await page.goto(target.url, { waitUntil: 'networkidle' });
    }
    if (!artifactLoaded()) {
      return null;
    }
    // Only a Markdown page: an HTML artifact is the author's own markup, so
    // a `pre.mermaid` there is not a fence this app rendered.
    if (mermaid !== undefined && mediaDefinition(target.mediaType).renderingMode === 'markdown') {
      await drawMermaidFences(page, { mermaid, progress, report, signal });
    }
    const shot = await page.screenshot({ quality: JPEG_QUALITY, type: 'jpeg' });
    return new Uint8Array(shot);
  }

  async function render(target: ThumbnailTarget): Promise<Uint8Array | null> {
    // Headless Chromium downloads a PDF instead of drawing it.
    if (disabled || target.mediaType === 'application/pdf') {
      return null;
    }
    const origin = new URL(target.url).origin;
    const launched = await currentBrowser(origin);
    if (launched === null) {
      return null;
    }
    // One deadline for the whole render, context creation included, raced
    // against the work rather than enforced by closing the context: Playwright
    // never settles a newPage() that a closing context interrupts, and a
    // Chromium that hangs without disconnecting never settles newContext().
    // Either would hold the queue for good. On the deadline the render rejects
    // at once and closes the context in the background, whenever it exists;
    // the abort also ends the Mermaid step (see mermaid-renderer.ts). A
    // deadline passed in that step counts against the Mermaid browser, which
    // the Mermaid renderer reports itself, not against this one.
    const deadlineReached = new AbortController();
    const deadline = setTimeout(() => {
      deadlineReached.abort(
        new Error(`Thumbnail render passed its ${String(timeoutMs)} ms deadline`),
      );
    }, timeoutMs);
    const creating = launched.newContext({
      acceptDownloads: false,
      colorScheme: 'dark',
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
      // See confineToOrigin: a preview is the static document, scripts off.
      // This is the per-page CDP switch; the launch-time blink setting in
      // `launch` is what actually guarantees it for every frame and process.
      javaScriptEnabled: false,
      viewport: VIEWPORT,
    });
    let context: BrowserContext | undefined;
    const progress: RenderProgress = { drawingDiagrams: false };
    const capturing = (async () => {
      context = await creating;
      await confineToOrigin(context, origin, publicBaseUrl);
      return capture(context, target, { progress, signal: deadlineReached.signal });
    })();
    try {
      const captured = await untilAborted(capturing, deadlineReached.signal);
      slot.rendered(launched);
      return captured;
    } finally {
      clearTimeout(deadline);
      if (deadlineReached.signal.aborted) {
        if (!progress.drawingDiagrams) {
          slot.missed(launched);
        }
        void ignoreFailure(capturing);
        void closeWhenCreated(creating);
      } else {
        await context?.close();
      }
    }
  }

  return {
    close: async () => {
      await Promise.all([mermaid?.close(), slot.close()]);
    },
    render,
  };
}
