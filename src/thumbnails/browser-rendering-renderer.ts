import type { BrowserWorker, WorkersLaunchOptions } from '@cloudflare/playwright';
import type { Browser } from 'playwright-core';

import { canCapture, captureThumbnail } from './capture.js';
import { ignoreFailure } from './settle.js';
import type { ThumbnailRenderer, ThumbnailTarget } from './types.js';

// The Worker's gallery preview renderer (ADR-0009), on Cloudflare Browser
// Rendering through @cloudflare/playwright. It hands each remote browser to
// the shared render rules in capture.ts, which name two launch obligations.
// Browser Rendering meets neither fully, so this records how each gap is
// closed instead:
//
// - No launch-time JavaScript switch. Browser Rendering takes no Chromium
//   flags, so only capture.ts's per-context switch turns scripts off, and a
//   sandboxed srcdoc frame in its own process can run script before that
//   applies. A script that wins that race runs in a browser that holds no
//   owner session cookie and no API key, only the signed URL of the artifact
//   it is part of, which grants a GET of that one artifact. Every route on
//   the Worker that changes anything needs the owner's session (`/logout`,
//   `/keys*`, `/secrets/new`), an API key (`/mcp`), or an unguessable token
//   or key (`/s/upload/*`, `/s/download/*`, `/s/*/reveal`). `POST /login` is
//   the only one open to anyone, and it is limited per client address and in
//   total (ADR-0005). So the script reaches what an anonymous internet client
//   reaches, and the guardrails below keep it on the app's host.
// - The network fence is hostname-only. Browser Rendering's guardrails are an
//   egress allowlist set when the session is acquired and latched for its
//   life, but they match hostnames, not ports, methods, or paths, and
//   capture.ts's request filter cannot see WebSockets. On workers.dev or on a
//   custom domain bound to this Worker, every port Cloudflare serves for the
//   hostname reaches this same Worker, so admitting every port on the host
//   reaches no other service. A Workers route that shares its hostname with
//   another origin server would expose that origin's GET surface to a script
//   that wins the race, so the supported deploys are a custom domain or
//   workers.dev.
//
// Sessions: a launch is rate-limited per minute and takes about a second, so
// one session serves every render while it lives, across Worker invocations.
// Only a session this renderer launched is ever reused, by the ID it
// remembers; a session from the account's list of sessions may belong to
// another Worker that launched it without guardrails, so that list is never
// read. A launch that is refused or rate-limited, or a session lost during a
// render, rejects with RenderUnavailableError, so the caller can retry later;
// resolving null still means the artifact has no preview to render.

// How long Browser Rendering keeps an idle session (10 s to 10 min): long
// enough for the next upload in a burst to reuse it.
const KEEP_ALIVE_MS = 120_000;

// A Browser Rendering browser. @cloudflare/playwright is a fork of
// Playwright with the same API, but its Browser type sits behind
// extensionless relative imports that this project's NodeNext resolution
// cannot follow, so the package's own launch() and connect() return an
// unresolved type. This is the one place that names that browser as
// playwright-core's Browser, which captureThumbnail takes.
export type RenderingBrowser = Browser & { sessionId: () => string };

// The parts of @cloudflare/playwright this renderer calls. Injected, so the
// Worker passes the package's own functions and tests pass a fake.
export type BrowserRenderingApi = {
  connect: (binding: BrowserWorker, sessionId: string) => Promise<RenderingBrowser>;
  launch: (binding: BrowserWorker, options: WorkersLaunchOptions) => Promise<RenderingBrowser>;
};

// The ID of the session this isolate's renderers last launched.
export type SessionMemory = { id: string | undefined };

// Module state, shared by every renderer in the isolate. It holds only an
// ID, never a connection: workerd lets no invocation use another's I/O.
const isolateSession: SessionMemory = { id: undefined };

type RendererOptions = {
  api: BrowserRenderingApi;
  binding: BrowserWorker;
  // MUNINN_PUBLIC_BASE_URL: the Worker renders each artifact at its signed
  // URL under this address, so its host is the one the guardrails admit.
  publicBaseUrl: string;
  report: (message: string) => void;
  // Where the launched session's ID is kept; the isolate's by default.
  session?: SessionMemory;
  timeoutMs?: number;
};

// A render that could not run because Browser Rendering refused a launch or
// lost the session. Retryable, unlike a render that resolves null.
export class RenderUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RenderUnavailableError';
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Renders on one Browser Rendering session at a time: the one `session`
// remembers when it can be reconnected, or a new one launched with the
// guardrails. The Worker builds a renderer for each invocation; only the
// session ID outlives it. A render that passes its deadline retires the
// session, since a stuck remote browser would otherwise be reconnected for
// good.
export function createBrowserRenderingRenderer({
  api,
  binding,
  publicBaseUrl,
  report,
  session = isolateSession,
  timeoutMs = 15_000,
}: RendererOptions): ThumbnailRenderer {
  const guardrails = { allowedDomains: [new URL(publicBaseUrl).hostname] };
  let opening: Promise<RenderingBrowser> | undefined;

  async function reconnect(id: string): Promise<RenderingBrowser | undefined> {
    try {
      return await api.connect(binding, id);
    } catch (error) {
      report(`Browser Rendering session not reconnected, launching another: ${describe(error)}`);
      return undefined;
    }
  }

  async function open(): Promise<RenderingBrowser> {
    const remembered = session.id;
    if (remembered !== undefined) {
      const reconnected = await reconnect(remembered);
      if (reconnected !== undefined) {
        return reconnected;
      }
    }
    let launched: RenderingBrowser;
    try {
      launched = await api.launch(binding, { guardrails, keep_alive: KEEP_ALIVE_MS });
    } catch (error) {
      throw new RenderUnavailableError(`Browser Rendering refused a launch: ${describe(error)}`, {
        cause: error,
      });
    }
    session.id = launched.sessionId();
    return launched;
  }

  // The open connection, opening one if there is none. A connection that
  // has dropped since the last render counts as a lost session.
  async function acquire(): Promise<RenderingBrowser> {
    const pending = (opening ??= open());
    let browser: RenderingBrowser;
    try {
      browser = await pending;
    } catch (error) {
      forget(pending);
      throw error;
    }
    if (!browser.isConnected()) {
      forget(pending);
      throw new RenderUnavailableError('Browser Rendering session lost between renders');
    }
    return browser;
  }

  function forget(pending: Promise<RenderingBrowser>): void {
    if (opening === pending) {
      opening = undefined;
    }
  }

  // Ends a session that stopped answering, so the next render launches anew.
  function retire(pending: Promise<RenderingBrowser>, browser: RenderingBrowser): void {
    forget(pending);
    if (session.id === browser.sessionId()) {
      session.id = undefined;
    }
    void ignoreFailure(browser.close());
  }

  async function render(target: ThumbnailTarget): Promise<Uint8Array | null> {
    if (!canCapture(target)) {
      return null;
    }
    const browser = await acquire();
    const pending = opening;
    try {
      return await captureThumbnail(
        browser,
        target,
        { publicBaseUrl, report, timeoutMs },
        {
          missed: () => {
            if (pending !== undefined) {
              retire(pending, browser);
            }
          },
          rendered: () => {},
        },
      );
    } catch (error) {
      if (browser.isConnected()) {
        throw error;
      }
      if (pending !== undefined) {
        forget(pending);
      }
      throw new RenderUnavailableError(`Browser Rendering session lost: ${describe(error)}`, {
        cause: error,
      });
    }
  }

  // Lets go of the connection but not the session, which the next
  // invocation reconnects while Browser Rendering keeps it alive.
  return {
    close: async () => {
      opening = undefined;
    },
    render,
  };
}
