import { createSocket } from 'node:dgram';
import type { Socket } from 'node:dgram';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Browser, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { groupRemains, killGroup, processGroupByPs } from './browser-processes.test-support.js';
import { BASE_CHROMIUM_ARGS, browserProcessId } from './chromium-launch.js';
import {
  createMermaidRenderer,
  MERMAID_CONTEXT_OPTIONS,
  mermaidLaunchOptions,
  openMermaidContext,
} from './mermaid-renderer.js';
import { resolveChromiumPath } from './playwright-renderer.js';

const chromiumPath = await resolveChromiumPath(process.env);
const mermaidBundle = createRequire(import.meta.url).resolve('mermaid/dist/mermaid.min.js');

const CHROMIUM_TIMEOUT_MS = 30_000;
const WARM_UP_TIMEOUT_MS = 120_000;

async function listen(app: Hono): Promise<{ server: ServerType; url: string }> {
  const server = serve({ fetch: app.fetch, port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address');
  }
  return { server, url: `http://127.0.0.1:${String(address.port)}` };
}

// Pins both network layers, so a change that drops one fails here even
// though the hostile-bundle tests below would still pass on the other.
describe('mermaidLaunchOptions', () => {
  it('sends every address to the dead proxy, keeps WebRTC off UDP, and resolves no name', () => {
    const options = mermaidLaunchOptions('/usr/bin/chromium');

    expect(options.proxy).toEqual({ bypass: '<-loopback>', server: 'http://127.0.0.1:9' });
    expect(options.args).toContain('--webrtc-ip-handling-policy=disable_non_proxied_udp');
    expect(options.args).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    expect(options.args).toContain('--host-resolver-rules=MAP * ~NOTFOUND');
    expect(options.args).toContain('--js-flags=--jitless');
    expect(options.executablePath).toBe('/usr/bin/chromium');
  });
});

describe('MERMAID_CONTEXT_OPTIONS', () => {
  it('takes each render context offline without service workers', () => {
    expect(MERMAID_CONTEXT_OPTIONS).toMatchObject({ offline: true, serviceWorkers: 'block' });
  });
});

// The host-resolver and DNS events a Chromium NetLog recorded for
// `hostname`. Full Chromium logs a lookup as DNS_TRANSACTION and the system
// resolver as HOST_RESOLVER_* tasks; matching on the name covers both.
// Chromium finishes the JSON on a clean exit; a log cut short is closed here.
async function resolverEventsFor(netLogPath: string, hostname: string): Promise<string[]> {
  const raw = await readFile(netLogPath, 'utf8');
  let log: {
    constants: { logEventTypes: Record<string, number> };
    events: { params?: unknown; type: number }[];
  };
  try {
    log = JSON.parse(raw);
  } catch {
    log = JSON.parse(`${raw.trimEnd().replace(/,$/u, '')}]}`);
  }
  const names = new Map(
    Object.entries(log.constants.logEventTypes).map(([name, type]) => [type, name]),
  );
  return log.events
    .map((event) => ({ name: names.get(event.type) ?? '', params: JSON.stringify(event.params) }))
    .filter(({ name, params }) => /DNS|HOST_RESOLVER/u.test(name) && params?.includes(hostname))
    .map(({ name }) => name);
}

describe('createMermaidRenderer without a bundle', () => {
  it('reports the unreadable bundle once and draws nothing', async () => {
    const reported: string[] = [];
    const mermaid = createMermaidRenderer({
      executablePath: chromiumPath,
      report: (message) => {
        reported.push(message);
      },
      scriptPath: '/nonexistent/mermaid.min.js',
    });

    await expect(mermaid.render(['graph TD; A-->B'])).resolves.toEqual([null]);
    await expect(mermaid.render(['graph TD; A-->B'])).resolves.toEqual([null]);

    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatch(/^Mermaid thumbnails disabled, /u);
    await mermaid.close();
  });

  it('handles a launch that fails after its signal aborted', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const reported: string[] = [];
    const mermaid = createMermaidRenderer({
      executablePath: '/nonexistent/chromium',
      report: (message) => {
        reported.push(message);
      },
      scriptPath: mermaidBundle,
    });
    try {
      // The deadline passed while the bundle was read, so the render gives
      // up before the launch it started has failed.
      await expect(mermaid.render(['graph TD; A-->B'], AbortSignal.abort())).rejects.toThrow(
        /aborted/u,
      );
      await delay(500);

      expect(unhandled).toEqual([]);
      await expect(mermaid.render(['graph TD; A-->B'])).resolves.toEqual([null]);
      expect(reported).toEqual([expect.stringMatching(/^Mermaid thumbnails disabled, /u)]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await mermaid.close();
    }
  });

  it('treats an empty bundle as missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'muninn-mermaid-bundle-'));
    try {
      const empty = join(dir, 'mermaid.min.js');
      await writeFile(empty, '', 'utf8');
      const reported: string[] = [];
      const mermaid = createMermaidRenderer({
        executablePath: chromiumPath,
        report: (message) => {
          reported.push(message);
        },
        scriptPath: empty,
      });

      await expect(mermaid.render(['graph TD; A-->B'])).resolves.toEqual([null]);
      expect(reported).toEqual([
        expect.stringMatching(/^Mermaid thumbnails disabled, the bundle .* is empty$/u),
      ]);
      await mermaid.close();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe.skipIf(chromiumPath === undefined)(
  'createMermaidRenderer',
  { timeout: CHROMIUM_TIMEOUT_MS },
  () => {
    let scratch: string;

    beforeAll(async () => {
      scratch = await mkdtemp(join(tmpdir(), 'muninn-mermaid-test-'));
    });

    afterAll(async () => {
      await rm(scratch, { force: true, recursive: true });
    });

    it(
      "draws each diagram with Mermaid's bundle and leaves one it cannot parse undrawn",
      async () => {
        const mermaid = createMermaidRenderer({
          executablePath: chromiumPath,
          scriptPath: mermaidBundle,
        });
        try {
          const [flowchart, sequence, broken] = await mermaid.render([
            'graph TD; A["<img src=x onerror=alert(1)>"]-->B',
            'sequenceDiagram\nA->>B: hi',
            'not a diagram',
          ]);

          expect(flowchart).toMatch(/^<svg /u);
          expect(flowchart).not.toMatch(/onerror/u);
          expect(sequence).toMatch(/^<svg /u);
          expect(broken).toBeNull();
        } finally {
          await mermaid.close();
        }
      },
      WARM_UP_TIMEOUT_MS,
    );

    it('stops a render once its signal aborts', async () => {
      // A bundle whose render never settles.
      const stuck = join(scratch, 'stuck.js');
      await writeFile(
        stuck,
        'globalThis.mermaid={initialize(){},render:()=>new Promise(()=>{})};',
        'utf8',
      );
      const mermaid = createMermaidRenderer({ executablePath: chromiumPath, scriptPath: stuck });
      try {
        const controller = new AbortController();
        setTimeout(() => {
          controller.abort();
        }, 1500);
        const started = Date.now();

        await expect(mermaid.render(['graph TD; A-->B'], controller.signal)).rejects.toThrow(
          /closed|aborted/u,
        );
        expect(Date.now() - started).toBeLessThan(4000);
      } finally {
        await mermaid.close();
      }
    });

    it(
      'stops waiting for a slow launch once its signal aborts',
      async () => {
        // A Chromium that takes 10s to start.
        const slow = join(scratch, 'slow-chromium.sh');
        await writeFile(
          slow,
          `#!/bin/sh\nsleep 10\nexec ${JSON.stringify(chromiumPath)} "$@"\n`,
          'utf8',
        );
        await chmod(slow, 0o755);
        const mermaid = createMermaidRenderer({ executablePath: slow, scriptPath: mermaidBundle });
        try {
          const started = Date.now();

          await expect(
            mermaid.render(['graph TD; A-->B'], AbortSignal.timeout(1000)),
          ).rejects.toThrow(/timed out|aborted/u);
          expect(Date.now() - started).toBeLessThan(3000);
        } finally {
          await mermaid.close();
        }
      },
      WARM_UP_TIMEOUT_MS,
    );

    it(
      'replaces a browser that stops responding once three drawings pass their deadline',
      async () => {
        const launches = vi.spyOn(chromium, 'launch');
        const mermaid = createMermaidRenderer({
          executablePath: chromiumPath,
          scriptPath: mermaidBundle,
        });
        let pid: number | undefined;
        let group: number | undefined;
        try {
          expect((await mermaid.render(['graph TD; A-->B']))[0]).toMatch(/^<svg /u);
          const stuck = await launches.mock.results[0]?.value;
          pid = stuck === undefined ? undefined : await browserProcessId(stuck);
          expect(pid).toBeDefined();
          // Stopped, it keeps its connection open but never answers.
          group = await processGroupByPs(pid ?? 0);
          process.kill(pid ?? 0, 'SIGSTOP');

          await expect(
            mermaid.render(['graph TD; A-->B'], AbortSignal.timeout(1000)),
          ).rejects.toThrow(/timed out|aborted/u);
          await expect(
            mermaid.render(['graph TD; A-->B'], AbortSignal.timeout(1000)),
          ).rejects.toThrow(/timed out|aborted/u);
          await expect(
            mermaid.render(['graph TD; A-->B'], AbortSignal.timeout(1000)),
          ).rejects.toThrow(/timed out|aborted/u);
          const [drawn] = await mermaid.render(['graph TD; A-->B'], AbortSignal.timeout(20_000));

          expect(drawn).toMatch(/^<svg /u);
          expect(launches).toHaveBeenCalledTimes(2);
          await expect.poll(() => groupRemains(group ?? 0), { timeout: 10_000 }).toBe(false);
        } finally {
          killGroup(group);
          launches.mockRestore();
          await mermaid.close();
        }
      },
      WARM_UP_TIMEOUT_MS,
    );

    it(
      'draws nothing for a render whose relaunch fails, then launches again for the next',
      async () => {
        const launch = chromium.launch.bind(chromium);
        const launches = vi.spyOn(chromium, 'launch');
        launches.mockImplementation(async (...args) => {
          if (launches.mock.calls.length === 2) {
            throw new Error('relaunch failed');
          }
          return launch(...args);
        });
        const reported: string[] = [];
        const mermaid = createMermaidRenderer({
          executablePath: chromiumPath,
          report: (message) => {
            reported.push(message);
          },
          scriptPath: mermaidBundle,
        });
        let group: number | undefined;
        try {
          expect((await mermaid.render(['graph TD; A-->B']))[0]).toMatch(/^<svg /u);
          const first = await launches.mock.results[0]?.value;
          group = await processGroupByPs((await browserProcessId(first)) ?? 0);
          killGroup(group);
          await expect.poll(() => first?.isConnected(), { timeout: 10_000 }).toBe(false);

          await expect(mermaid.render(['graph TD; A-->B'])).resolves.toEqual([null]);
          const [drawn] = await mermaid.render(['graph TD; A-->B']);

          expect(drawn).toMatch(/^<svg /u);
          expect(launches).toHaveBeenCalledTimes(3);
          expect(reported).toEqual([expect.stringMatching(/relaunch failed/u)]);
          expect(reported[0]).not.toMatch(/disabled/u);
        } finally {
          killGroup(group);
          launches.mockRestore();
          await mermaid.close();
        }
      },
      WARM_UP_TIMEOUT_MS,
    );

    it('stops a render whose signal aborts at any point while the page opens', async () => {
      const stuck = join(scratch, 'stuck.js');
      await writeFile(
        stuck,
        'globalThis.mermaid={initialize(){},render:()=>new Promise(()=>{})};',
        'utf8',
      );
      // Keeps hold of the Mermaid browser, to count what each abort leaves open.
      const launches = vi.spyOn(chromium, 'launch');
      const mermaid = createMermaidRenderer({ executablePath: chromiumPath, scriptPath: stuck });
      try {
        // Warm the browser, so each abort below lands while a context and
        // page are being opened rather than during the launch.
        await expect(
          mermaid.render(['graph TD; A-->B'], AbortSignal.timeout(1000)),
        ).rejects.toThrow(/timed out|aborted|closed/u);
        const outcomes = await Promise.all(
          [0, 2, 5, 10, 15, 20, 30, 50, 80].map(async (delayMs) => {
            const started = Date.now();
            await mermaid
              .render(['graph TD; A-->B'], AbortSignal.timeout(delayMs))
              .catch(() => null);
            return Date.now() - started - delayMs;
          }),
        );

        // Every render gives up within moments of its own abort, and every
        // context it opened is closed behind it.
        expect(outcomes.filter((lateMs) => lateMs > 1000)).toEqual([]);
        const browser = await launches.mock.results[0]?.value;
        await expect.poll(() => browser?.contexts().length, { timeout: 5000 }).toBe(0);
      } finally {
        launches.mockRestore();
        await mermaid.close();
      }
    });

    describe('with a bundle that tries to reach the network', () => {
      let neighbour: ServerType;
      let neighbourUrl: string;
      let neighbourHits = 0;
      let neighbourUpgrades = 0;
      let udp: Socket;
      let udpPackets = 0;
      let hostile: string;
      let escaping: string;

      beforeAll(async () => {
        const app = new Hono();
        app.all('*', (c) => {
          neighbourHits += 1;
          return c.text('INTERNAL');
        });
        ({ server: neighbour, url: neighbourUrl } = await listen(app));
        neighbour.on('upgrade', (_request, socket) => {
          neighbourUpgrades += 1;
          socket.destroy();
        });
        udp = createSocket('udp4');
        udp.on('message', () => {
          udpPackets += 1;
        });
        udp.bind(0, '127.0.0.1');
        await once(udp, 'listening');
        const udpPort = String(udp.address().port);
        const wsUrl = neighbourUrl.replace('http', 'ws');

        // Stands in for a Mermaid bug that lets diagram text run script: the
        // bundle itself tries every network path, then draws normally. Each
        // attempt stands alone, so one that throws cannot mask the rest.
        hostile = join(scratch, 'hostile.js');
        await writeFile(
          hostile,
          `try{fetch('${neighbourUrl}/fetch')}catch{}` +
            `try{fetch('${neighbourUrl}/post',{method:'POST',body:'{}'})}catch{}` +
            `try{new Image().src='${neighbourUrl}/img'}catch{}` +
            `try{navigator.sendBeacon('${neighbourUrl}/beacon','x')}catch{}` +
            `try{new WebSocket('${wsUrl}/ws')}catch{}` +
            `try{new Worker(URL.createObjectURL(new Blob(["fetch('${neighbourUrl}/worker');new WebSocket('${wsUrl}/ws-worker')"],{type:'text/javascript'})))}catch{}` +
            `try{new SharedWorker(URL.createObjectURL(new Blob(["fetch('${neighbourUrl}/shared')"],{type:'text/javascript'})))}catch{}` +
            `try{const f=document.createElement('iframe');f.src='${neighbourUrl}/frame';document.body.append(f)}catch{}` +
            `try{const pc=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${udpPort}'}]});` +
            `pc.createDataChannel('x');pc.createOffer().then(o=>pc.setLocalDescription(o))}catch{}` +
            `globalThis.mermaid={initialize(){},render:async(id)=>({svg:'<svg id="'+id+'"></svg>'})};`,
          'utf8',
        );

        // The same attempts from a sandboxed frame and a popup, each in a
        // process of its own, where only launch-time settings are certain to
        // apply before the first script runs. Each reports back once its
        // attempts have run, and the drawing lists who reported, so the test
        // knows the attempts were made rather than never reached.
        const attempts =
          `try{fetch('${neighbourUrl}/escaped')}catch{}` +
          `try{new WebSocket('${wsUrl}/ws-escaped')}catch{}` +
          `try{const pc=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${udpPort}'}]});` +
          `pc.createDataChannel('x');pc.createOffer().then(o=>pc.setLocalDescription(o))}catch{}` +
          `(window.opener??parent).postMessage(window.opener?'popup':'frame','*');`;
        escaping = join(scratch, 'escaping.js');
        await writeFile(
          escaping,
          `const code=${JSON.stringify(`<script>${attempts}</script>`)};` +
            `const ran=new Set();addEventListener('message',(e)=>ran.add(e.data));` +
            `try{window.open(URL.createObjectURL(new Blob([code],{type:'text/html'})))}catch{}` +
            `try{const f=document.createElement('iframe');f.sandbox='allow-scripts';f.srcdoc=code;document.body.append(f)}catch{}` +
            `globalThis.mermaid={initialize(){},render:()=>new Promise((resolve)=>{` +
            `const started=Date.now();const check=()=>ran.size===2||Date.now()-started>5000` +
            `?resolve({svg:'<svg data-ran="'+[...ran].sort().join(',')+'"></svg>'}):setTimeout(check,50);check()})};`,
          'utf8',
        );
      });

      // Each test starts from zero, so a leak fails the test that caused it.
      beforeEach(() => {
        neighbourHits = 0;
        neighbourUpgrades = 0;
        udpPackets = 0;
      });

      afterAll(async () => {
        await promisify(neighbour.close.bind(neighbour))();
        udp.close();
      });

      // Runs the hostile bundle in `page` and waits for ICE's STUN retries.
      async function runHostileBundle(page: Page): Promise<void> {
        await page.addScriptTag({ path: hostile });
        await expect(page.evaluate(() => 'mermaid' in globalThis)).resolves.toBe(true);
        // ICE retries STUN at ~0.3s, 0.5s, 1s; wait long enough to catch one.
        await delay(1200);
      }

      it('refuses every request with only the launch layer in place', async () => {
        const browser: Browser = await chromium.launch(mermaidLaunchOptions(chromiumPath));
        try {
          const page = await (await browser.newContext()).newPage();
          await page.setContent('<!doctype html><body></body>');
          await runHostileBundle(page);

          expect(neighbourHits).toBe(0);
          expect(neighbourUpgrades).toBe(0);
          expect(udpPackets).toBe(0);
        } finally {
          await browser.close();
        }
      });

      // DNS is the launch layer's alone (see the NetLog test); this layer
      // covers HTTP, WebSocket, and WebRTC.
      it('refuses every request with only the context layer in place', async () => {
        const browser: Browser = await chromium.launch({
          args: BASE_CHROMIUM_ARGS,
          ...(chromiumPath === undefined ? {} : { executablePath: chromiumPath }),
        });
        try {
          // A blank page, not the Mermaid page: Chromium itself refuses
          // requests from that public-looking origin to loopback, which
          // would hide whether this layer stops HTTP and WebSocket.
          const page = await (await openMermaidContext(browser)).newPage();
          await page.setContent('<!doctype html><body></body>');
          await runHostileBundle(page);

          expect(neighbourHits).toBe(0);
          expect(neighbourUpgrades).toBe(0);
          expect(udpPackets).toBe(0);
        } finally {
          await browser.close();
        }
      });

      // The request filter on its own: with the context back online, every
      // request but the page's own is aborted by the filter (Chromium reports
      // that as ERR_BLOCKED_BY_CLIENT). Counting hits would prove nothing
      // here: Chromium also refuses requests from this public-looking page to
      // loopback, and WebSocket and WebRTC are not routed at all.
      it("aborts the page's own HTTP requests at the request filter", async () => {
        const browser: Browser = await chromium.launch({
          args: BASE_CHROMIUM_ARGS,
          ...(chromiumPath === undefined ? {} : { executablePath: chromiumPath }),
        });
        try {
          const context = await openMermaidContext(browser);
          await context.setOffline(false);
          const failures = new Map<string, string>();
          context.on('requestfailed', (request) => {
            failures.set(new URL(request.url()).pathname, request.failure()?.errorText ?? '');
          });
          const page = await context.newPage();
          await page.goto('http://mermaid.invalid/');
          await page.evaluate((url) => {
            void fetch(`${url}/fetch`).catch(() => null);
            const image = new Image();
            image.src = `${url}/img`;
            navigator.sendBeacon(`${url}/beacon`, 'x');
            const frame = document.createElement('iframe');
            frame.src = `${url}/frame`;
            document.body.append(frame);
          }, neighbourUrl);
          await delay(1000);

          // Chromium appends `.Inspector` to some of these.
          const blockedByFilter = expect.stringMatching(/^net::ERR_BLOCKED_BY_CLIENT/u);
          expect(Object.fromEntries(failures)).toEqual({
            '/beacon': blockedByFilter,
            '/fetch': blockedByFilter,
            '/frame': blockedByFilter,
            '/img': blockedByFilter,
          });
          expect(neighbourHits).toBe(0);
        } finally {
          await browser.close();
        }
      });

      it('refuses every request the page makes', async () => {
        const mermaid = createMermaidRenderer({
          executablePath: chromiumPath,
          scriptPath: hostile,
        });
        try {
          const drawn = await mermaid.render(['graph TD; A-->B']);
          // ICE retries STUN at ~0.3s, 0.5s, 1s; wait long enough to catch one.
          await delay(1200);

          expect(drawn).toEqual(['<svg id="thumbnail-diagram-0"></svg>']);
          expect(neighbourHits).toBe(0);
          expect(neighbourUpgrades).toBe(0);
          expect(udpPackets).toBe(0);
        } finally {
          await mermaid.close();
        }
      });

      it('resolves no hostname, even for a WebRTC TURN server over TCP', async () => {
        // A wrapper that starts the real Chromium with a NetLog, which
        // records every DNS transaction the network stack makes.
        const netLog = join(scratch, 'netlog.json');
        const wrapper = join(scratch, 'chromium-with-netlog.sh');
        await writeFile(
          wrapper,
          `#!/bin/sh\nexec ${JSON.stringify(chromiumPath)} --log-net-log=${JSON.stringify(netLog)} "$@"\n`,
          'utf8',
        );
        await chmod(wrapper, 0o755);
        const resolving = join(scratch, 'resolving.js');
        await writeFile(
          resolving,
          `try{const pc=new RTCPeerConnection({iceServers:[{urls:'turn:muninn-dns-probe.example.org:3478?transport=tcp',username:'u',credential:'c'}]});` +
            `pc.createDataChannel('x');pc.createOffer().then(o=>pc.setLocalDescription(o))}catch{}` +
            `globalThis.mermaid={initialize(){},render:()=>new Promise((resolve)=>{setTimeout(()=>resolve({svg:'<svg></svg>'}),1500)})};`,
          'utf8',
        );
        const mermaid = createMermaidRenderer({ executablePath: wrapper, scriptPath: resolving });
        try {
          await mermaid.render(['graph TD; A-->B']);
        } finally {
          await mermaid.close();
        }

        await expect(resolverEventsFor(netLog, 'muninn-dns-probe.example.org')).resolves.toEqual(
          [],
        );
      });

      it('refuses requests from frames and popups in other processes', async () => {
        const mermaid = createMermaidRenderer({
          executablePath: chromiumPath,
          scriptPath: escaping,
        });
        try {
          const drawn = await mermaid.render(['graph TD; A-->B']);
          await delay(1200);

          expect(drawn).toEqual(['<svg data-ran="frame,popup"></svg>']);
          expect(neighbourHits).toBe(0);
          expect(neighbourUpgrades).toBe(0);
          expect(udpPackets).toBe(0);
        } finally {
          await mermaid.close();
        }
      });
    });
  },
);
