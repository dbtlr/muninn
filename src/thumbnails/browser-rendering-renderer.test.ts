import { describe, expect, it, vi } from 'vite-plus/test';

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

const HTML_TARGET: ThumbnailTarget = {
  id: 'a1',
  mediaType: 'text/html',
  url: `${PUBLIC_BASE_URL}/a/a1?expires=1&signature=s`,
};

type RouteHandler = (route: FakeRoute) => unknown;
type FakeRoute = {
  abort: (reason: string) => void;
  continue: () => void;
  fulfill: (response: unknown) => void;
  request: () => { method: () => string; url: () => string };
};

type FakeSession = {
  // Each context a render created on this session: its options and the
  // request filter it installed.
  contexts: { options: unknown; route: RouteHandler | undefined }[];
  // When set, a page load never finishes, so the render passes its deadline.
  hangOnNextRender: boolean;
  // When set, creating a context loses the session first.
  loseOnNextRender: boolean;
};

// One Browser Rendering session's Browser. It answers only what a render
// calls, so it cannot satisfy Playwright's whole Browser type: the one
// assertion below is that boundary.
function fakeBrowser(sessionId: string, session: FakeSession): RenderingBrowser {
  let connected = true;
  const browser = {
    close: vi.fn(async () => {
      connected = false;
    }),
    isConnected: () => connected,
    newContext: async (options: unknown) => {
      if (session.loseOnNextRender) {
        connected = false;
        throw new Error('Browser has been closed');
      }
      const record: FakeSession['contexts'][number] = { options, route: undefined };
      session.contexts.push(record);
      return {
        close: async () => {},
        newPage: async () => {
          const listeners: ((response: unknown) => void)[] = [];
          return {
            goto: async (url: string) => {
              if (session.hangOnNextRender) {
                await Promise.withResolvers<never>().promise;
              }
              for (const listener of listeners) {
                listener({ ok: () => true, url: () => new URL(url).href });
              }
            },
            locator: () => ({ allTextContents: async () => [] }),
            on: (_event: string, listener: (response: unknown) => void) => {
              listeners.push(listener);
            },
            screenshot: async () => JPEG,
            setContent: async () => {},
            setDefaultTimeout: () => {},
          };
        },
        route: async (_pattern: string, handler: RouteHandler) => {
          record.route = handler;
        },
      };
    },
    sessionId: () => sessionId,
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a partial fake of Playwright's Browser
  return browser as unknown as RenderingBrowser;
}

// The account's Browser Rendering: sessions by id, the launches and connects
// made, and an account-wide `sessions()` list holding a session this
// renderer never launched.
function fakeBrowserRendering() {
  const sessions = new Map<string, FakeSession>();
  let launchCount = 0;
  const api = {
    connect: vi.fn(async (_binding: unknown, sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session === undefined) {
        throw new Error(`Unable to connect to browser: code: 404: session ${sessionId}`);
      }
      return fakeBrowser(sessionId, session);
    }),
    launch: vi.fn(async (_binding: unknown, _options: unknown) => {
      launchCount += 1;
      const id = `launched-${String(launchCount)}`;
      const session: FakeSession = {
        contexts: [],
        hangOnNextRender: false,
        loseOnNextRender: false,
      };
      sessions.set(id, session);
      return fakeBrowser(id, session);
    }),
    // Never to be called: another Worker on the account may have launched
    // these without guardrails.
    sessions: vi.fn(async () => [{ sessionId: 'someone-elses', startTime: 0 }]),
  } satisfies BrowserRenderingApi & { sessions: unknown };
  sessions.set('someone-elses', {
    contexts: [],
    hangOnNextRender: false,
    loseOnNextRender: false,
  });
  return { api, sessions };
}

const BINDING = { fetch: async () => new Response(null, { status: 500 }) };

function renderer(
  api: BrowserRenderingApi,
  session: SessionMemory = { id: undefined },
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

describe('createBrowserRenderingRenderer', () => {
  it('launches with guardrails naming only the public host and a keep-alive', async () => {
    const { api } = fakeBrowserRendering();
    const withPort = createBrowserRenderingRenderer({
      api,
      binding: BINDING,
      publicBaseUrl: 'https://muninn.example.com:8443/base',
      report: () => {},
      session: { id: undefined },
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
    const memory: SessionMemory = { id: undefined };
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

  it('launches its own session rather than use any other on the account', async () => {
    const { api } = fakeBrowserRendering();

    await renderer(api).render(HTML_TARGET);

    expect(api.sessions).not.toHaveBeenCalled();
    expect(api.connect).not.toHaveBeenCalled();
    expect(api.launch).toHaveBeenCalledTimes(1);
  });

  it('launches a fresh session when the remembered one cannot be reconnected', async () => {
    const { api } = fakeBrowserRendering();
    const memory: SessionMemory = { id: 'expired' };

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

    await expect(refused.render(HTML_TARGET)).rejects.toBeInstanceOf(RenderUnavailableError);
    // The refusal is not remembered: the next render launches again.
    await expect(refused.render(HTML_TARGET)).resolves.toEqual(JPEG);
  });

  it('rejects with RenderUnavailableError when the session is lost during a render', async () => {
    const { api, sessions } = fakeBrowserRendering();
    const memory: SessionMemory = { id: undefined };
    const losing = renderer(api, memory);
    await losing.render(HTML_TARGET);
    const session = sessions.get('launched-1');
    if (session === undefined) {
      throw new Error('Expected the launched session');
    }
    session.loseOnNextRender = true;

    await expect(losing.render(HTML_TARGET)).rejects.toBeInstanceOf(RenderUnavailableError);

    // The next render does not use the lost connection: it reconnects.
    session.loseOnNextRender = false;
    await expect(losing.render(HTML_TARGET)).resolves.toEqual(JPEG);
    expect(api.connect).toHaveBeenCalledWith(BINDING, 'launched-1');
  });

  it('retires a session whose render passed its deadline', async () => {
    const { api, sessions } = fakeBrowserRendering();
    const memory: SessionMemory = { id: undefined };
    const slow = renderer(api, memory, 50);
    await slow.render(HTML_TARGET);
    const session = sessions.get('launched-1');
    if (session === undefined) {
      throw new Error('Expected the launched session');
    }
    session.hangOnNextRender = true;

    await expect(slow.render(HTML_TARGET)).rejects.toThrow(/deadline/u);

    expect(memory.id).toBeUndefined();
    await expect(slow.render(HTML_TARGET)).resolves.toEqual(JPEG);
    expect(api.launch).toHaveBeenCalledTimes(2);
    expect(memory.id).toBe('launched-2');
  });

  it('declines a target that cannot be rendered without starting a session', async () => {
    const { api } = fakeBrowserRendering();

    await expect(
      renderer(api).render({ ...HTML_TARGET, mediaType: 'application/pdf' }),
    ).resolves.toBeNull();

    expect(api.launch).not.toHaveBeenCalled();
  });

  it('renders under the shared rules: scripts off, only GETs to the render origin', async () => {
    const { api, sessions } = fakeBrowserRendering();

    await renderer(api).render(HTML_TARGET);

    const context = sessions.get('launched-1')?.contexts[0];
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
});
