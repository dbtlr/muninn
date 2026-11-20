import type { BrowserWorker, WorkersLaunchOptions } from '@cloudflare/playwright';
import type { Browser } from 'playwright-core';

import { canCapture, captureThumbnail, MISSES_BEFORE_REPLACING } from './capture.js';
import { closeWhenCreated, ignoreFailure, untilAborted } from './settle.js';
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
//   owner session cookie and no API key, only signed URLs: the artifact's
//   own, and those of the artifacts its page embeds (the app signs each
//   embed for the view). Each grants a GET of one artifact the author chose
//   to show. Every route on the Worker that changes anything needs the
//   owner's session (`/logout`, `/keys*`, `/secrets/new`), an API key
//   (`/mcp`), or an unguessable token or key (`/s/upload/*`,
//   `/s/download/*`, `/s/*/reveal`). `POST /login` is the only one open to
//   anyone, and it is limited per client address and in total (ADR-0005).
//   So the script reaches what an anonymous internet client reaches, and the
//   guardrails below keep it on the app's host.
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
// one session serves every render while it lives, within an isolate: its ID
// (and its count of missed deadlines) is module state that every renderer in
// the isolate shares. Only a session this renderer launched is ever reused,
// by the ID it remembers; a session from the account's list of sessions may
// belong to another Worker that launched it without guardrails, so that list
// is never read. A launch that is refused, rate-limited, or not finished in
// time, or a session lost during a render, rejects with
// RenderUnavailableError, so the caller can retry later. A render that fails
// otherwise, including one that passes its deadline, rejects with a plain
// error; resolving null still means the artifact has no preview to render.
//
// Known limits:
// - A launch acquires its session first, then opens its WebSocket and CDP
//   connection. When that second step fails, the session is left alive, and
//   unremembered, until its keep-alive runs out.
// - Concurrent invocations in one isolate each open their own connection. If
//   Browser Rendering admits one connection per session, the later ones fail
//   to reconnect and each launches a session of its own.

// How long Browser Rendering keeps an idle session (10 s to 10 min): long
// enough for the next upload in a burst to reuse it.
const KEEP_ALIVE_MS = 120_000;

// How long acquiring a session may take, for a reconnect or a launch. A
// launch takes about a second; one still unsettled after 10 s counts as
// refused, so a Browser Rendering that never answers cannot hold a render
// for good. A reconnect that runs out falls through to a launch.
const ACQUIRE_TIMEOUT_MS = 10_000;

// How long retiring a session waits for the remote browser to take CDP's
// Browser.close before it drops the connection regardless.
const END_SESSION_TIMEOUT_MS = 2000;

// Playwright's message for a call on a page, context, or browser whose
// connection has closed (its TargetClosedError). Matched by message: the
// client-side class is not exported and keeps the name `Error`, and the
// Worker bundle takes nothing from Playwright at run time.
const TARGET_CLOSED = /Target page, context or browser has been closed|Target closed/u;

// A Browser Rendering browser. @cloudflare/playwright is a fork of
// Playwright, but its Browser type sits behind extensionless relative
// imports that this project's NodeNext resolution cannot follow, so the
// package's own launch() and connect() return an unresolved type. This is
// the one place that names that browser as playwright-core's Browser, which
// captureThumbnail takes. @cloudflare/playwright 1.3.6 forks upstream
// Playwright 1.58.2 while playwright-core here is ^1.63, so this assertion
// can hide API drift: capture.ts must use only APIs that 1.58 has.
export type RenderingBrowser = Browser & { sessionId: () => string };

// The parts of @cloudflare/playwright this renderer calls. Injected, so the
// Worker passes the package's own functions and tests pass a fake.
export type BrowserRenderingApi = {
  connect: (binding: BrowserWorker, sessionId: string) => Promise<RenderingBrowser>;
  launch: (binding: BrowserWorker, options: WorkersLaunchOptions) => Promise<RenderingBrowser>;
};

// The session this isolate's renderers last launched: its ID, and how many
// renders in a row have passed their deadline on it.
export type SessionMemory = { id: string | undefined; misses: number };

// Module state, shared by every renderer in the isolate. It holds an ID and
// a count, never a connection: workerd lets no invocation use another's I/O.
const isolateSession: SessionMemory = { id: undefined, misses: 0 };

type RendererOptions = {
  api: BrowserRenderingApi;
  binding: BrowserWorker;
  // MUNINN_PUBLIC_BASE_URL: the Worker renders each artifact at its signed
  // URL under this address, so its host is the one the guardrails admit.
  publicBaseUrl: string;
  report: (message: string) => void;
  // Where the launched session is remembered; the isolate's by default.
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

// An open connection to a session, and whether Playwright has reported it
// disconnected since.
type Connection = { browser: RenderingBrowser; lost: boolean };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Settles as `work` does, or rejects with `message` once `ms` pass.
async function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  const expiry = new AbortController();
  const timer = setTimeout(() => {
    expiry.abort(new Error(message));
  }, ms);
  try {
    return await untilAborted(work, expiry.signal);
  } finally {
    clearTimeout(timer);
  }
}

// Waits up to ACQUIRE_TIMEOUT_MS for a launch or reconnect. One that arrives
// later is closed, so it is not left open.
async function acquiredInTime(
  attempt: Promise<RenderingBrowser>,
  what: string,
): Promise<RenderingBrowser> {
  try {
    return await within(
      attempt,
      ACQUIRE_TIMEOUT_MS,
      `${what} took longer than ${String(ACQUIRE_TIMEOUT_MS)} ms`,
    );
  } catch (error) {
    void closeWhenCreated(attempt);
    throw error;
  }
}

// Ends a session. On a browser from connect(), Playwright's close() only
// drops the connection (only launch() makes it end the session), so the
// session is first ended over CDP. Best effort: a browser stuck enough to
// retire may not answer, and Browser Rendering ends the session anyway once
// its keep-alive runs out.
async function endSession(browser: RenderingBrowser): Promise<void> {
  const closing = (async () => {
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send('Browser.close');
  })();
  await ignoreFailure(
    within(closing, END_SESSION_TIMEOUT_MS, 'Browser.close was not answered in time'),
  );
  await browser.close();
}

// Renders on one Browser Rendering session at a time: the one `session`
// remembers when it can be reconnected, or a new one launched with the
// guardrails. The Worker builds a renderer for each invocation; only the
// session's ID and miss count outlive it. Three renders in a row that pass
// their deadline on a session retire it, as on Node, since a stuck remote
// browser would otherwise be reconnected for good.
export function createBrowserRenderingRenderer({
  api,
  binding,
  publicBaseUrl,
  report,
  session = isolateSession,
  timeoutMs = 15_000,
}: RendererOptions): ThumbnailRenderer {
  const guardrails = { allowedDomains: [new URL(publicBaseUrl).hostname] };
  let opening: Promise<Connection> | undefined;

  async function reconnect(id: string): Promise<RenderingBrowser | undefined> {
    try {
      return await acquiredInTime(api.connect(binding, id), 'Reconnecting');
    } catch (error) {
      report(`Browser Rendering session not reconnected, launching another: ${describe(error)}`);
      return undefined;
    }
  }

  async function launch(): Promise<RenderingBrowser> {
    let launched: RenderingBrowser;
    try {
      launched = await acquiredInTime(
        api.launch(binding, { guardrails, keep_alive: KEEP_ALIVE_MS }),
        'A launch',
      );
    } catch (error) {
      throw new RenderUnavailableError(`Browser Rendering refused a launch: ${describe(error)}`, {
        cause: error,
      });
    }
    session.id = launched.sessionId();
    session.misses = 0;
    return launched;
  }

  async function open(): Promise<Connection> {
    const remembered = session.id;
    const browser =
      (remembered === undefined ? undefined : await reconnect(remembered)) ?? (await launch());
    const connection: Connection = { browser, lost: false };
    browser.on('disconnected', () => {
      connection.lost = true;
    });
    return connection;
  }

  // The open connection, opening one if there is none, with the promise it
  // came from. A connection that has dropped since the last render counts as
  // a lost session.
  async function acquire(): Promise<{ connection: Connection; pending: Promise<Connection> }> {
    const pending = (opening ??= open());
    let connection: Connection;
    try {
      connection = await pending;
    } catch (error) {
      forget(pending);
      throw error;
    }
    if (!connection.browser.isConnected()) {
      forget(pending);
      throw new RenderUnavailableError('Browser Rendering session lost between renders');
    }
    return { connection, pending };
  }

  function forget(pending: Promise<Connection>): void {
    if (opening === pending) {
      opening = undefined;
    }
  }

  // Ends a session that stopped answering, so the next render reconnects to
  // the remembered session or launches anew. The memory is cleared only
  // when it still names this session, never a newer one.
  function retire(pending: Promise<Connection>, browser: RenderingBrowser): void {
    forget(pending);
    if (session.id === browser.sessionId()) {
      session.id = undefined;
      session.misses = 0;
    }
    void ignoreFailure(endSession(browser));
  }

  // Counts a missed deadline against the remembered session, retiring it at
  // the limit. A session no longer remembered is retired at once: nothing
  // will reconnect it, and the next render moves to the remembered one.
  function missed(pending: Promise<Connection>, browser: RenderingBrowser): void {
    if (session.id === browser.sessionId()) {
      session.misses += 1;
      if (session.misses < MISSES_BEFORE_REPLACING) {
        return;
      }
    }
    retire(pending, browser);
  }

  async function render(target: ThumbnailTarget): Promise<Uint8Array | null> {
    if (!canCapture(target)) {
      return null;
    }
    const { connection, pending } = await acquire();
    const { browser } = connection;
    let missedDeadline = false;
    try {
      return await captureThumbnail(
        browser,
        target,
        { publicBaseUrl, report, timeoutMs },
        {
          missed: () => {
            missedDeadline = true;
            missed(pending, browser);
          },
          rendered: () => {
            if (session.id === browser.sessionId()) {
              session.misses = 0;
            }
          },
        },
      );
    } catch (error) {
      // A passed deadline is the render's own failure, even when retiring
      // the session, or a drop while it waited, has closed the browser since.
      const lost = connection.lost || TARGET_CLOSED.test(describe(error));
      if (missedDeadline || !lost) {
        throw error;
      }
      forget(pending);
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
