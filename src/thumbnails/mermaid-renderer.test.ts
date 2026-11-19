import { createSocket } from 'node:dgram';
import type { Socket } from 'node:dgram';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import {
  createMermaidRenderer,
  MERMAID_CONTEXT_OPTIONS,
  mermaidLaunchOptions,
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
  it('sends every address to the dead proxy and keeps WebRTC off UDP', () => {
    const options = mermaidLaunchOptions('/usr/bin/chromium');

    expect(options.proxy).toEqual({ bypass: '<-loopback>', server: 'http://127.0.0.1:9' });
    expect(options.args).toContain('--webrtc-ip-handling-policy=disable_non_proxied_udp');
    expect(options.args).toContain('--js-flags=--jitless');
    expect(options.executablePath).toBe('/usr/bin/chromium');
  });
});

describe('MERMAID_CONTEXT_OPTIONS', () => {
  it('takes each render context offline without service workers', () => {
    expect(MERMAID_CONTEXT_OPTIONS).toMatchObject({ offline: true, serviceWorkers: 'block' });
  });
});

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

    describe('with a bundle that tries to reach the network', () => {
      let neighbour: ServerType;
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
        let neighbourUrl: string;
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

      afterAll(async () => {
        await promisify(neighbour.close.bind(neighbour))();
        udp.close();
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
