import { readFile } from 'node:fs/promises';

import type { Browser, BrowserContext } from 'playwright-core';

// Launch settings and helpers both thumbnail browsers share: the artifact
// renderer (playwright-renderer.ts) and the Mermaid renderer
// (mermaid-renderer.ts).

// TCP port 9 (discard) on loopback: nothing listens there, so proxied
// connections are refused at once rather than hanging.
export const DEAD_PROXY = 'http://127.0.0.1:9';

export const BASE_CHROMIUM_ARGS = [
  // The runtime container runs as an unprivileged user without the kernel
  // features Chromium's own sandbox wants, so neither browser has it. The
  // artifact browser runs no script at all; the Mermaid browser runs
  // Mermaid's bundle on artifact-supplied diagram text, which is the residual
  // risk ADR-0010 records.
  '--no-sandbox',
  '--disable-dev-shm-usage',
];

// Playwright's own signal handlers close the browser but swallow the signal,
// which would leave the HTTP server running through a `docker stop`.
// server.ts owns shutdown and calls close().
export const SIGNALS_LEFT_TO_SERVER = {
  handleSIGHUP: false,
  handleSIGINT: false,
  handleSIGTERM: false,
};

// How long a Chromium launch may take before it fails. Playwright's own
// default is 180 s, all of it spent ahead of any render's deadline; a cold
// disk can still need tens of seconds.
export const LAUNCH_TIMEOUT_MS = 60_000;

// Consecutive renders that may pass their deadline on one browser before it
// is taken for stuck and replaced. More than one, so a single slow artifact
// does not cost a relaunch.
export const MISSES_BEFORE_REPLACING = 3;

// How long the launch may take to report the browser's process. A browser
// that does not answer by then is kept, but cannot be killed as a group.
const PROCESS_LOOKUP_TIMEOUT_MS = 5000;

// The shared Chromium behind one renderer: launched on first use, replaced
// after a crash or once it stops answering, and ended with every process it
// started. A render reports how it went: `rendered` when it finished,
// `missed` when it passed its deadline. Reports about a browser the slot
// already replaced are ignored.
export type BrowserSlot = {
  // The current browser, launching one if there is none. Rejects when the
  // launch fails; the next call launches again.
  acquire: () => Promise<Browser>;
  close: () => Promise<void>;
  missed: (browser: Browser) => void;
  rendered: (browser: Browser) => void;
};

type SlotEntry = {
  browser: Browser;
  ended: boolean;
  // The process group Playwright started the browser in (it launches
  // Chromium detached, as the leader of a new group).
  group: number | undefined;
  misses: number;
};

// The browser process's id, asked over CDP while the browser still answers;
// undefined when it does not answer in time.
export async function browserProcessId(browser: Browser): Promise<number | undefined> {
  const lookup = (async () => {
    const session = await browser.newBrowserCDPSession();
    try {
      const { processInfo } = await session.send('SystemInfo.getProcessInfo');
      return processInfo.find((entry) => entry.type === 'browser')?.id;
    } finally {
      await session.detach().catch(() => undefined);
    }
  })();
  void ignoreFailure(lookup);
  try {
    return await untilAborted(lookup, AbortSignal.timeout(PROCESS_LOOKUP_TIMEOUT_MS));
  } catch {
    return undefined;
  }
}

// The process group `pid` belongs to, from /proc on Linux. Debian's
// chromium-headless-shell runs the browser under a parent process that leads
// the group, so the browser's own id is not the group's. Elsewhere (macOS)
// the browser process leads its group, and its id is returned.
export async function processGroupOf(pid: number): Promise<number> {
  try {
    const stat = await readFile(`/proc/${String(pid)}/stat`, 'utf8');
    // The command name may hold spaces and parentheses; the fields after its
    // closing parenthesis are state, parent, then process group.
    const group = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
    return Number.isInteger(group) && group > 0 ? group : pid;
  } catch {
    return pid;
  }
}

// The browser's process group, or undefined when it cannot be told apart
// from this server's own (which a group kill would end too).
async function browserProcessGroup(browser: Browser): Promise<number | undefined> {
  const pid = await browserProcessId(browser);
  if (pid === undefined) {
    return undefined;
  }
  const [group, ownGroup] = await Promise.all([processGroupOf(pid), processGroupOf(process.pid)]);
  return group > 1 && group !== ownGroup ? group : undefined;
}

// SIGKILL to the whole group. A stopped browser never acts on a close request
// (Playwright's close then waits forever), and processes whose parent died
// keep running; neither needs the browser to answer this.
function killProcessGroup(group: number | undefined): void {
  if (group === undefined) {
    return;
  }
  try {
    process.kill(-group, 'SIGKILL');
  } catch {
    // The group is already gone.
  }
}

export function createBrowserSlot(
  launch: () => Promise<Browser>,
  missLimit = MISSES_BEFORE_REPLACING,
): BrowserSlot {
  let current: Promise<SlotEntry> | undefined;
  let settled: SlotEntry | undefined;
  // Bumped whenever the slot lets go of its browser or launch, so a launch
  // that finishes afterwards does not claim the slot.
  let generation = 0;

  function release(): void {
    generation += 1;
    current = undefined;
    settled = undefined;
  }

  // Takes the entry out of the slot, so the next acquire launches anew, and
  // ends its processes. Safe to call again for the same entry.
  function end(entry: SlotEntry): void {
    if (settled === entry) {
      release();
    }
    if (!entry.ended) {
      entry.ended = true;
      killProcessGroup(entry.group);
    }
  }

  async function start(token: number): Promise<SlotEntry> {
    let browser: Browser;
    try {
      browser = await launch();
    } catch (error) {
      if (token === generation) {
        release();
      }
      throw error;
    }
    const entry: SlotEntry = {
      browser,
      ended: false,
      group: await browserProcessGroup(browser),
      misses: 0,
    };
    browser.on('disconnected', () => {
      end(entry);
    });
    if (token === generation) {
      settled = entry;
      // Died during the launch: this render fails, the next one launches anew.
      if (!browser.isConnected()) {
        end(entry);
      }
    }
    return entry;
  }

  function entryFor(browser: Browser): SlotEntry | undefined {
    return settled?.browser === browser ? settled : undefined;
  }

  return {
    acquire: async () => {
      current ??= start(generation);
      return (await current).browser;
    },
    close: async () => {
      const closing = current;
      release();
      if (closing === undefined) {
        return;
      }
      let entry: SlotEntry;
      try {
        entry = await closing;
      } catch {
        // A launch that failed was already reported; there is nothing to close.
        return;
      }
      await ignoreFailure(entry.browser.close());
      end(entry);
    },
    missed: (browser) => {
      const entry = entryFor(browser);
      if (entry !== undefined) {
        entry.misses += 1;
        if (entry.misses >= missLimit) {
          end(entry);
          void ignoreFailure(entry.browser.close());
        }
      }
    },
    rendered: (browser) => {
      const entry = entryFor(browser);
      if (entry !== undefined) {
        entry.misses = 0;
      }
    },
  };
}

// Closes a render's context, ignoring one that a deadline or crash already
// closed.
export async function closeQuietly(context: BrowserContext): Promise<void> {
  try {
    await context.close();
  } catch {
    // Already closed; nothing to do.
  }
}

// Closes a context whose creation a render stopped waiting for, once it exists.
export async function closeWhenCreated(creating: Promise<BrowserContext>): Promise<void> {
  try {
    await closeQuietly(await creating);
  } catch {
    // Never created; nothing to close.
  }
}

// Awaits `promise` only to mark its rejection handled.
export async function ignoreFailure(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // Whoever awaits it next sees the failure.
  }
}

// Settles as `promise` does, or rejects as soon as `signal` aborts.
export async function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
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
