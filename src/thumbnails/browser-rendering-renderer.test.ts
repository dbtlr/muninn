import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  createBrowserRenderingRenderer,
  RenderUnavailableError,
} from './browser-rendering-renderer.js';
import type {
  BrowserRenderingApi,
  RenderingBrowser,
  SessionMemory,
} from './browser-rendering-renderer.js';
import type { ThumbnailTarget } from './types.js';

// A stand-in for @cloudflare/playwright and the Browser Rendering sessions
// behind it: no network, no browser. Each fake browser answers just enough of
// Playwright's API for captureThumbnail to take a screenshot, and records the
// context options and request filter the render installed.

const PUBLIC_BASE_URL = 'https://muninn.example.workers.dev';
const JPEG = Uint8Array.of(255, 216, 255, 224);

// Playwright's message for a call on a browser whose connection has closed.
const TARGET_CLOSED = 'Target page, context or browser has been closed';

const HTML_TARGET: ThumbnailTarget = {
  id: 'a1',
  mediaType: 'text/html',
  url: `${PUBLIC_BASE_URL}/a/a1?expires=1&signature=s`,
};

type RouteHandler = (route: FakeRoute) => unknown;
type FakeRoute = {
  abort: (reason: string) => void;
  continue: () => void;
  fulfill: (response: { headers?: Record<string, string>; status?: number }) => void;
  request: () => { method: () => string; url: () => string };
};

// What the session's browser does on the next render, until changed:
// - draws: renders the page and takes the screenshot.
// - hangs: the page load never finishes, so the render passes its deadline.
// - hangs, then drops: as hangs, and the session's connection drops while
//   the page load waits, without that load ever settling.
// - disconnects: the connection drops (Playwright emits `disconnected`) as
//   the render creates its context, which then fails with a transport error.
// - loses its target: the remote browser receives CDP Browser.close during
//   the page load, as the real one did in testing. The load fails with
//   Playwright's target-closed error, closing the context fails with a
//   protocol error, and `disconnected` comes a tick later.
// - fails: the screenshot fails while the browser stays connected.
type Behaviour =
  | 'disconnects'
  | 'draws'
  | 'fails'
  | 'hangs'
  | 'hangs, then drops'
  | 'loses its target';

type FakeSession = {
  // Each context a render created on this session: its options and the
  // request filter it installed.
  contexts: { options: unknown; route: RouteHandler | undefined }[];
  behaviour: Behaviour;
  // Set once Browser.close ended the session; it can no longer be connected.
  ended: boolean;
};

function newSession(): FakeSession {
  return { behaviour: 'draws', contexts: [], ended: false };
}

// A fake browser's handles for the test: the browser itself, how many times
// its connection was closed, and a way to drop its connection.
type FakeConnection = {
  browser: RenderingBrowser;
  closes: () => number;
  drop: () => void;
};

async function tick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  await promise;
}

// One connection to a Browser Rendering session. A browser from launch()
// ends its session when closed, as @cloudflare/playwright's launch() makes
// it; one from connect() only drops its connection. Either drops it a tick
// after close(), then emits `disconnected`, as Playwright does.
function fakeConnection(
  sessionId: string,
  session: FakeSession,
  { launched }: { launched: boolean },
): FakeConnection {
  let connected = true;
  let closeCount = 0;
  const onDisconnected: (() => void)[] = [];
  const drop = (): void => {
    if (connected) {
      connected = false;
      for (const listener of onDisconnected) {
        listener();
      }
    }
  };
  const endSession = (): void => {
    session.ended = true;
  };
  const browser = {
    close: vi.fn(async () => {
      closeCount += 1;
      if (launched) {
        endSession();
      }
      await tick();
      drop();
    }),
    isConnected: () => connected,
    newBrowserCDPSession: async () => {
      if (!connected) {
        throw new Error(`browser.newBrowserCDPSession: ${TARGET_CLOSED}`);
      }
      return {
        detach: async () => {},
        send: async (method: string) => {
          if (method === 'Browser.close') {
            endSession();
            setTimeout(drop, 0);
          }
          return {};
        },
      };
    },
    newContext: async (options: unknown) => {
      if (!connected) {
        throw new Error(`browser.newContext: ${TARGET_CLOSED}`);
      }
      if (session.behaviour === 'disconnects') {
        drop();
        throw new Error('browser.newContext: WebSocket error: connection reset');
      }
      const record: FakeSession['contexts'][number] = { options, route: undefined };
      session.contexts.push(record);
      const { behaviour } = session;
      return {
        close: async () => {
          if (behaviour === 'loses its target') {
            throw new Error(
              'browserContext.close: Protocol error (Target.disposeBrowserContext): Failed to find context with id 7',
            );
          }
        },
        newPage: async () => {
          const listeners: ((response: unknown) => void)[] = [];
          return {
            goto: async (url: string) => {
              if (behaviour === 'hangs' || behaviour === 'hangs, then drops') {
                if (behaviour === 'hangs, then drops') {
                  setTimeout(drop, 0);
                }
                await Promise.withResolvers<never>().promise;
              }
              if (behaviour === 'loses its target') {
                endSession();
                setTimeout(drop, 0);
                throw new Error(`page.goto: ${TARGET_CLOSED}`);
              }
              for (const listener of listeners) {
                listener({ ok: () => true, url: () => new URL(url).href });
              }
            },
            locator: () => ({ allTextContents: async () => [] }),
            on: (_event: string, listener: (response: unknown) => void) => {
              listeners.push(listener);
            },
            screenshot: async () => {
              if (behaviour === 'fails') {
                throw new Error(
                  'page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot',
                );
              }
              return JPEG;
            },
            setContent: async () => {},
            setDefaultTimeout: () => {},
          };
        },
        route: async (_pattern: string, handler: RouteHandler) => {
          record.route = handler;
        },
      };
    },
    on: (event: string, listener: () => void) => {
      if (event === 'disconnected') {
        onDisconnected.push(listener);
      }
    },
    sessionId: () => sessionId,
  };
  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a partial fake of Playwright's Browser
    browser: browser as unknown as RenderingBrowser,
    closes: () => closeCount,
    drop,
  };
}

// The account's Browser Rendering: sessions by id, the launches and connects
// made, every connection handed out, and an account-wide `sessions()` list
// holding a session this renderer never launched.
function fakeBrowserRendering() {
  const sessions = new Map<string, FakeSession>();
  const connections: FakeConnection[] = [];
  let launchCount = 0;
  // A new session and the launched browser for it, as launch() makes.
  const launchSession = (): RenderingBrowser => {
    launchCount += 1;
    const id = `launched-${String(launchCount)}`;
    const session = newSession();
    sessions.set(id, session);
    const connection = fakeConnection(id, session, { launched: true });
    connections.push(connection);
    return connection.browser;
  };
  const api = {
    connect: vi.fn(async (_binding: unknown, sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session === undefined || session.ended) {
        throw new Error(`Unable to connect to browser: code: 404: session ${sessionId}`);
      }
      const connection = fakeConnection(sessionId, session, { launched: false });
      connections.push(connection);
      return connection.browser;
    }),
    launch: vi.fn(async (_binding: unknown, _options: unknown) => launchSession()),
    // Never to be called: another Worker on the account may have launched
    // these without guardrails.
    sessions: vi.fn(async () => [{ sessionId: 'someone-elses', startTime: 0 }]),
  } satisfies BrowserRenderingApi & { sessions: unknown };
  sessions.set('someone-elses', newSession());

  function sessionNamed(id: string): FakeSession {
    const found = sessions.get(id);
    if (found === undefined) {
      throw new Error(`Expected session ${id}`);
    }
    return found;
  }

  function connectionAt(index: number): FakeConnection {
    const found = connections[index];
    if (found === undefined) {
      throw new Error(`Expected connection ${String(index)}`);
    }
    return found;
  }

  return { api, connectionAt, launchSession, sessionNamed };
}

const BINDING = { fetch: async () => new Response(null, { status: 500 }) };

function emptyMemory(): SessionMemory {
  return { id: undefined, misses: 0 };
}

function renderer(
  api: BrowserRenderingApi,
  session: SessionMemory = emptyMemory(),
  timeoutMs?: number,
): ReturnType<typeof createBrowserRenderingRenderer> {
  return createBrowserRenderingRenderer({
    api,
    binding: BINDING,
    publicBaseUrl: PUBLIC_BASE_URL,
    report: () => {},
    session,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

// The error `promise` rejects with, so a test can check its class.
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject');
}

// Whether `promise` has settled yet.
function settledFlag(promise: Promise<unknown>): () => boolean {
  let settled = false;
  void (async () => {
    try {
      await promise;
    } catch {
      // Settled either way.
    }
    settled = true;
  })();
  return () => settled;
}

// A deadline short enough for tests whose renders hang.
const DEADLINE_MS = 50;

afterEach(() => {
  vi.useRealTimers();
});

describe('createBrowserRenderingRenderer', () => {
  it('launches with guardrails naming only the public host and a keep-alive', async () => {
    const { api } = fakeBrowserRendering();
    const withPort = createBrowserRenderingRenderer({
      api,
      binding: BINDING,
      publicBaseUrl: 'https://muninn.example.com:8443/base',
      report: () => {},
      session: emptyMemory(),
    });

    await withPort.render({ ...HTML_TARGET, url: 'https://muninn.example.com:8443/base/a/a1' });

    expect(api.launch).toHaveBeenCalledTimes(1);
    expect(api.launch).toHaveBeenCalledWith(BINDING, {
      guardrails: { allowedDomains: ['muninn.example.com'] },
      keep_alive: 120_000,
    });
  });

  it('reuses its session across renders and across renderers that share the memory', async () => {
    const { api } = fakeBrowserRendering();
    const memory = emptyMemory();
    const first = renderer(api, memory);

    await expect(first.render(HTML_TARGET)).resolves.toEqual(JPEG);
    await expect(first.render(HTML_TARGET)).resolves.toEqual(JPEG);
    await first.close();
    // A later Worker invocation builds a new renderer.
    await expect(renderer(api, memory).render(HTML_TARGET)).resolves.toEqual(JPEG);

    expect(api.launch).toHaveBeenCalledTimes(1);
    expect(api.connect).toHaveBeenCalledTimes(1);
    expect(api.connect).toHaveBeenCalledWith(BINDING, 'launched-1');
  });

  it('lets go of its connection on close and reconnects on the next render', async () => {
    const { api } = fakeBrowserRendering();
    const closing = renderer(api);
    await closing.render(HTML_TARGET);

    await closing.close();
    await expect(closing.render(HTML_TARGET)).resolves.toEqual(JPEG);

    expect(api.launch).toHaveBeenCalledTimes(1);
    expect(api.connect).toHaveBeenCalledTimes(1);
    expect(api.connect).toHaveBeenCalledWith(BINDING, 'launched-1');
  });

  it('launches its own session rather than use any other on the account', async () => {
    const { api } = fakeBrowserRendering();

    await renderer(api).render(HTML_TARGET);

    expect(api.sessions).not.toHaveBeenCalled();
    expect(api.connect).not.toHaveBeenCalled();
    expect(api.launch).toHaveBeenCalledTimes(1);
  });

  it('launches a fresh session when the remembered one cannot be reconnected', async () => {
    const { api } = fakeBrowserRendering();
    const memory: SessionMemory = { id: 'expired', misses: 0 };

    await expect(renderer(api, memory).render(HTML_TARGET)).resolves.toEqual(JPEG);

    expect(api.connect).toHaveBeenCalledWith(BINDING, 'expired');
    expect(api.launch).toHaveBeenCalledTimes(1);
    expect(memory.id).toBe('launched-1');
  });

  it('rejects with RenderUnavailableError when the launch is refused', async () => {
    const { api } = fakeBrowserRendering();
    api.launch.mockRejectedValueOnce(
      new Error('Unable to create new browser: code: 429: message: Too many requests'),
    );
    const refused = renderer(api);

    await expect(rejectionOf(refused.render(HTML_TARGET))).resolves.toBeInstanceOf(
      RenderUnavailableError,
    );
    // The refusal is not remembered: the next render launches again.
    await expect(refused.render(HTML_TARGET)).resolves.toEqual(JPEG);
  });

  it('rejects with RenderUnavailableError when the connection dropped between renders', async () => {
    const { api, connectionAt } = fakeBrowserRendering();
    const dropping = renderer(api);
    await dropping.render(HTML_TARGET);
    connectionAt(0).drop();

    const error = await rejectionOf(dropping.render(HTML_TARGET));

    expect(error).toBeInstanceOf(RenderUnavailableError);
    expect(error).toHaveProperty('message', expect.stringMatching(/between renders/u));
    // The dropped connection is let go: the next render reconnects.
    await expect(dropping.render(HTML_TARGET)).resolves.toEqual(JPEG);
    expect(api.connect).toHaveBeenCalledWith(BINDING, 'launched-1');
  });

  it('rejects with RenderUnavailableError when the connection drops during a render', async () => {
    const { api, sessionNamed } = fakeBrowserRendering();
    const losing = renderer(api);
    await losing.render(HTML_TARGET);
    sessionNamed('launched-1').behaviour = 'disconnects';

    await expect(rejectionOf(losing.render(HTML_TARGET))).resolves.toBeInstanceOf(
      RenderUnavailableError,
    );

    // The next render does not use the lost connection: it reconnects.
    sessionNamed('launched-1').behaviour = 'draws';
    await expect(losing.render(HTML_TARGET)).resolves.toEqual(JPEG);
    expect(api.connect).toHaveBeenCalledWith(BINDING, 'launched-1');
  });

  it('rejects with RenderUnavailableError when the remote browser closes mid-render', async () => {
    const { api, sessionNamed } = fakeBrowserRendering();
    const losing = renderer(api);
    await losing.render(HTML_TARGET);
    sessionNamed('launched-1').behaviour = 'loses its target';

    const error = await rejectionOf(losing.render(HTML_TARGET));

    expect(error).toBeInstanceOf(RenderUnavailableError);
    // The render's own failure, not the context close that failed after it.
    expect(error).toHaveProperty('message', expect.stringContaining(TARGET_CLOSED));
  });

  it('rejects with a plain error when a render fails on a browser that is still there', async () => {
    const { api, sessionNamed } = fakeBrowserRendering();
    const failing = renderer(api);
    await failing.render(HTML_TARGET);
    sessionNamed('launched-1').behaviour = 'fails';

    const error = await rejectionOf(failing.render(HTML_TARGET));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RenderUnavailableError);
    expect(error).toHaveProperty('message', expect.stringMatching(/Unable to capture screenshot/u));
  });

  it('rejects with a plain error when a render passes its deadline', async () => {
    const { api, sessionNamed } = fakeBrowserRendering();
    const slow = renderer(api, emptyMemory(), DEADLINE_MS);
    await slow.render(HTML_TARGET);
    sessionNamed('launched-1').behaviour = 'hangs';

    const error = await rejectionOf(slow.render(HTML_TARGET));

    expect(error).not.toBeInstanceOf(RenderUnavailableError);
    expect(error).toHaveProperty('message', expect.stringMatching(/deadline/u));
  });

  it('reports a passed deadline as such even when the connection dropped while it waited', async () => {
    const { api, sessionNamed } = fakeBrowserRendering();
    const slow = renderer(api, emptyMemory(), DEADLINE_MS);
    await slow.render(HTML_TARGET);
    sessionNamed('launched-1').behaviour = 'hangs, then drops';

    const error = await rejectionOf(slow.render(HTML_TARGET));

    expect(error).not.toBeInstanceOf(RenderUnavailableError);
    expect(error).toHaveProperty('message', expect.stringMatching(/deadline/u));
  });

  it('retires a session after three renders in a row pass their deadline, across renderers', async () => {
    const { api, sessionNamed } = fakeBrowserRendering();
    const memory = emptyMemory();
    const first = renderer(api, memory, DEADLINE_MS);
    await first.render(HTML_TARGET);
    sessionNamed('launched-1').behaviour = 'hangs';
    await expect(first.render(HTML_TARGET)).rejects.toThrow(/deadline/u);
    await first.close();
    // A later invocation reconnects, and the misses so far still count.
    const second = renderer(api, memory, DEADLINE_MS);
    await expect(second.render(HTML_TARGET)).rejects.toThrow(/deadline/u);
    expect(memory.id).toBe('launched-1');

    const third = await rejectionOf(second.render(HTML_TARGET));

    expect(third).not.toBeInstanceOf(RenderUnavailableError);
    expect(third).toHaveProperty('message', expect.stringMatching(/deadline/u));
    expect(memory.id).toBeUndefined();
    // A reconnected browser's close() only drops the connection, so the
    // session itself is ended too.
    await tick();
    expect(sessionNamed('launched-1').ended).toBe(true);
    await expect(second.render(HTML_TARGET)).resolves.toEqual(JPEG);
    expect(api.launch).toHaveBeenCalledTimes(2);
    expect(memory.id).toBe('launched-2');
  });

  it('starts the count of missed deadlines over after a render that finishes', async () => {
    const { api, sessionNamed } = fakeBrowserRendering();
    const memory = emptyMemory();
    const slow = renderer(api, memory, DEADLINE_MS);
    await slow.render(HTML_TARGET);
    const launched = sessionNamed('launched-1');

    launched.behaviour = 'hangs';
    await expect(slow.render(HTML_TARGET)).rejects.toThrow(/deadline/u);
    await expect(slow.render(HTML_TARGET)).rejects.toThrow(/deadline/u);
    launched.behaviour = 'draws';
    await expect(slow.render(HTML_TARGET)).resolves.toEqual(JPEG);
    launched.behaviour = 'hangs';
    await expect(slow.render(HTML_TARGET)).rejects.toThrow(/deadline/u);

    expect(memory.id).toBe('launched-1');
    expect(launched.ended).toBe(false);
    expect(api.launch).toHaveBeenCalledTimes(1);
  });

  it('starts the miss count of a newly launched session at zero', async () => {
    const { api, launchSession, sessionNamed } = fakeBrowserRendering();
    const memory: SessionMemory = { id: 'expired', misses: 2 };
    api.launch.mockImplementationOnce(async () => {
      const launched = launchSession();
      sessionNamed('launched-1').behaviour = 'hangs';
      return launched;
    });

    await expect(renderer(api, memory, DEADLINE_MS).render(HTML_TARGET)).rejects.toThrow(
      /deadline/u,
    );

    expect(memory).toEqual({ id: 'launched-1', misses: 1 });
  });

  it('retires a session it no longer remembers without forgetting the one it does', async () => {
    const { api, connectionAt, sessionNamed } = fakeBrowserRendering();
    const memory = emptyMemory();
    const slow = renderer(api, memory, DEADLINE_MS);
    await slow.render(HTML_TARGET);
    // Another renderer in the isolate launched a newer session since.
    memory.id = 'launched-newer';
    sessionNamed('launched-1').behaviour = 'hangs';

    await expect(slow.render(HTML_TARGET)).rejects.toThrow(/deadline/u);

    expect(memory.id).toBe('launched-newer');
    await tick();
    expect(sessionNamed('launched-1').ended).toBe(true);
    expect(connectionAt(0).closes()).toBe(1);
  });

  it('gives a render 15 seconds by default', async () => {
    vi.useFakeTimers();
    const { api, sessionNamed } = fakeBrowserRendering();
    const slow = renderer(api);
    await slow.render(HTML_TARGET);
    sessionNamed('launched-1').behaviour = 'hangs';

    const rendering = slow.render(HTML_TARGET);
    const failure = rejectionOf(rendering);
    const settled = settledFlag(rendering);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(failure).resolves.toHaveProperty(
      'message',
      expect.stringMatching(/15000 ms deadline/u),
    );
  });

  it('gives up on a launch that does not finish in 10 seconds, and closes it if it does', async () => {
    vi.useFakeTimers();
    const { api, launchSession, sessionNamed } = fakeBrowserRendering();
    const late = Promise.withResolvers<RenderingBrowser>();
    api.launch.mockImplementationOnce(async () => late.promise);
    const waiting = renderer(api);

    const rendering = waiting.render(HTML_TARGET);
    const failure = rejectionOf(rendering);
    const settled = settledFlag(rendering);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(failure).resolves.toBeInstanceOf(RenderUnavailableError);
    late.resolve(launchSession());
    await vi.advanceTimersByTimeAsync(1);
    expect(sessionNamed('launched-1').ended).toBe(true);
  });

  it('launches anew when a reconnect does not finish in 10 seconds', async () => {
    vi.useFakeTimers();
    const { api } = fakeBrowserRendering();
    api.connect.mockImplementationOnce(async () => Promise.withResolvers<never>().promise);
    const memory: SessionMemory = { id: 'stalled', misses: 0 };

    const rendering = renderer(api, memory).render(HTML_TARGET);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(rendering).resolves.toEqual(JPEG);
    expect(api.launch).toHaveBeenCalledTimes(1);
    expect(memory.id).toBe('launched-1');
  });

  it('declines a target that cannot be rendered without starting a session', async () => {
    const { api } = fakeBrowserRendering();

    await expect(
      renderer(api).render({ ...HTML_TARGET, mediaType: 'application/pdf' }),
    ).resolves.toBeNull();

    expect(api.launch).not.toHaveBeenCalled();
  });

  it('renders under the shared rules: scripts off, only GETs to the render origin', async () => {
    const { api, sessionNamed } = fakeBrowserRendering();

    await renderer(api).render(HTML_TARGET);

    const context = sessionNamed('launched-1').contexts[0];
    expect(context?.options).toMatchObject({ javaScriptEnabled: false });
    const outcomes: string[] = [];
    const route = (method: string, url: string): FakeRoute => ({
      abort: () => outcomes.push(`abort ${method} ${url}`),
      continue: () => outcomes.push(`continue ${method} ${url}`),
      fulfill: () => outcomes.push(`fulfill ${method} ${url}`),
      request: () => ({ method: () => method, url: () => url }),
    });
    await context?.route?.(route('GET', `${PUBLIC_BASE_URL}/assets/app.css`));
    await context?.route?.(route('POST', `${PUBLIC_BASE_URL}/mcp`));
    await context?.route?.(route('GET', 'https://elsewhere.example/x.png'));

    expect(outcomes).toEqual([
      `continue GET ${PUBLIC_BASE_URL}/assets/app.css`,
      `abort POST ${PUBLIC_BASE_URL}/mcp`,
      'abort GET https://elsewhere.example/x.png',
    ]);
  });

  it('loads an embed under the public base URL from the render origin', async () => {
    const { api, sessionNamed } = fakeBrowserRendering();

    await renderer(api).render({ ...HTML_TARGET, url: 'https://render.example/a/a1' });

    const redirects: unknown[] = [];
    await sessionNamed('launched-1').contexts[0]?.route?.({
      abort: () => redirects.push('aborted'),
      continue: () => redirects.push('continued'),
      fulfill: (response) => redirects.push(response),
      request: () => ({ method: () => 'GET', url: () => `${PUBLIC_BASE_URL}/a/a2?expires=1` }),
    });

    expect(redirects).toEqual([
      { headers: { Location: 'https://render.example/a/a2?expires=1' }, status: 302 },
    ]);
  });
});
