import type { Browser, BrowserContext, Page } from 'playwright-core';

import { mediaDefinition } from '../artifacts/media.js';
import { closeQuietly, closeWhenCreated, ignoreFailure, untilAborted } from './settle.js';
import type { MermaidRenderer, ThumbnailTarget } from './types.js';

// The render rules for one gallery preview, shared by every runtime: what a
// render may load, how the page is drawn, and the deadline that bounds it.
// Each runtime launches its own browser, then hands it to captureThumbnail.
// These rules hold only when that launch meets two obligations (Node meets
// both in playwright-renderer.ts):
// - Scripts off from launch, in every frame and process. The per-context
//   switch set here is applied after a frame exists, and a sandboxed srcdoc
//   frame in a process of its own can run script before it applies.
// - A network fence below the browser that lets connections reach only the
//   render origin's host and port, from any page or frame. The request
//   filter here cannot see WebSockets or every request from a sandboxed
//   frame, so a fence that admits the whole host lets such a frame reach
//   other services on it.
// A runtime that cannot meet one of them must close that gap another way.
// Type imports only from Playwright and Node: the Worker bundle must be able
// to reach this file, and the lint config enforces it.

// Rendered at a desktop width, then captured at half scale: the gallery
// shows a card a few hundred pixels wide, so 640x400 is plenty and keeps
// each JPEG a few tens of kilobytes.
const VIEWPORT = { height: 800, width: 1280 };
const DEVICE_SCALE_FACTOR = 0.5;
const JPEG_QUALITY = 80;

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
// rendered here runs with nobody watching, and every script-driven network
// path (fetch, WebSocket, WebTransport, WebRTC, workers, popups) turned out
// to need its own fence with its own gaps. So the render runs with
// JavaScript off (the first launch obligation above, backed by the context
// setting in captureThumbnail), which removes that whole class. A
// Markdown artifact's mermaid fences are drawn in a separate browser that
// runs only Mermaid, with no network at all (ADR-0010), and swapped into the
// page before the screenshot.
//
// What remains is declarative loads (img, iframe, stylesheet, meta refresh),
// fenced twice. The launch fence (the second obligation above; on Node, a
// proxy nobody listens on) stops every connection to anywhere but the render
// origin's host and port. This request filter then narrows that to GETs on
// the render origin, scheme included, which keeps /mcp out of reach even
// from a form.
//
// A GET under the public base URL names this same server by the address
// visitors use, which the renderer may not be able to reach. It never goes
// to the network: the filter answers it with a redirect to the same path and
// query on the render origin, so the embed shows and the render still loads
// only from its own origin. Chromium follows that redirect as a GET, which
// Playwright does not route again; its target is the one host and port the
// launch fence lets through.
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

export type CaptureOptions = {
  // Draws a Markdown artifact's mermaid fences; without it they show as source.
  mermaid?: MermaidRenderer | undefined;
  // This instance's public base URL (MUNINN_PUBLIC_BASE_URL). Artifacts
  // embed each other by the full URL add_artifact returns; a render loads
  // those from its own origin instead (see confineToOrigin).
  publicBaseUrl?: string | undefined;
  report: (message: string) => void;
  // Upper bound for one whole render, from creating its context to the
  // screenshot.
  timeoutMs: number;
};

// What a render tells the runtime that owns the browser, so it can judge
// whether the browser still answers.
export type CaptureHooks = {
  // The deadline passed while the browser itself was working. Not called for
  // a deadline passed while drawing diagrams: that wait is on the Mermaid
  // renderer, which counts it against its own browser when one was drawing,
  // and against neither while that browser is still launching (a slow launch
  // is not a stuck browser).
  missed: () => void;
  // The render finished before its deadline, with bytes or a decline.
  rendered: () => void;
};

// Consecutive renders that may pass their deadline on one browser before
// its runtime takes it for stuck and replaces it. More than one, so a single
// slow artifact does not cost a relaunch.
export const MISSES_BEFORE_REPLACING = 3;

async function capture(
  context: BrowserContext,
  target: ThumbnailTarget,
  {
    mermaid,
    progress,
    report,
    signal,
    timeoutMs,
  }: Omit<CaptureOptions, 'publicBaseUrl'> & { progress: RenderProgress; signal: AbortSignal },
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

// Whether a render is worth starting: headless Chromium downloads a PDF
// instead of drawing it. A runtime checks this before it launches a browser.
export function canCapture(target: ThumbnailTarget): boolean {
  return target.mediaType !== 'application/pdf';
}

// Renders one artifact in `browser` and resolves to JPEG bytes, or null when
// it cannot be captured (see canCapture) or the server did not serve it.
// Each render gets its own short-lived context, so no cookies, cache, or
// storage carry over from one artifact to the next. Rejects when the
// deadline passes or the browser fails.
//
// One deadline covers the whole render, context creation included, raced
// against the work rather than enforced by closing the context: Playwright
// never settles a newPage() that a closing context interrupts, and a
// Chromium that hangs without disconnecting never settles newContext().
// Either would hold the queue for good. On the deadline the render rejects
// at once and closes the context in the background, whenever it exists; the
// abort also ends the Mermaid step (see mermaid-renderer.ts). A deadline
// passed in that step never counts against this browser (see CaptureHooks).
export async function captureThumbnail(
  browser: Browser,
  target: ThumbnailTarget,
  { mermaid, publicBaseUrl, report, timeoutMs }: CaptureOptions,
  hooks: CaptureHooks,
): Promise<Uint8Array | null> {
  if (!canCapture(target)) {
    return null;
  }
  const origin = new URL(target.url).origin;
  const deadlineReached = new AbortController();
  const deadline = setTimeout(() => {
    deadlineReached.abort(
      new Error(`Thumbnail render passed its ${String(timeoutMs)} ms deadline`),
    );
  }, timeoutMs);
  const creating = browser.newContext({
    acceptDownloads: false,
    colorScheme: 'dark',
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    // See confineToOrigin: a preview is the static document, scripts off.
    // This is the per-page CDP switch, applied after a frame exists. It does
    // not cover a sandboxed srcdoc frame in its own process; the launch-time
    // setting (the first obligation in the header) is what guarantees it.
    javaScriptEnabled: false,
    viewport: VIEWPORT,
  });
  let context: BrowserContext | undefined;
  const progress: RenderProgress = { drawingDiagrams: false };
  const capturing = (async () => {
    context = await creating;
    await confineToOrigin(context, origin, publicBaseUrl);
    return capture(context, target, {
      mermaid,
      progress,
      report,
      signal: deadlineReached.signal,
      timeoutMs,
    });
  })();
  let captured: Uint8Array | null;
  try {
    captured = await untilAborted(capturing, deadlineReached.signal);
  } catch (error) {
    clearTimeout(deadline);
    if (deadlineReached.signal.aborted) {
      if (!progress.drawingDiagrams) {
        hooks.missed();
      }
      void ignoreFailure(capturing);
      void closeWhenCreated(creating);
    } else if (context !== undefined) {
      // The render failed, often because the browser went away, and then
      // closing its context fails too. That second failure would hide why.
      await closeQuietly(context);
    }
    throw error;
  }
  clearTimeout(deadline);
  try {
    hooks.rendered();
  } catch (error) {
    // The hook's failure is the one to report, not a failed close after it.
    if (context !== undefined) {
      await closeQuietly(context);
    }
    throw error;
  }
  await context?.close();
  return captured;
}
