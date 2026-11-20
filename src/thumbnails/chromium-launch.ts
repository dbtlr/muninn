import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

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

// How long the launch may take to report the browser's process; most of a
// slow host's launch budget, since the render that launched the browser waits
// for it. A browser that does not answer by then is still used, but its
// process group is unknown: once it is retired, its processes are ended only
// if Playwright's close succeeds, and a stopped browser's never are. They keep
// running until Muninn exits.
const PROCESS_LOOKUP_TIMEOUT_MS = 30_000;

// How long closing the slot waits for Playwright's graceful close before it
// kills the browser's process group anyway. A stopped browser never answers
// the close request, and Playwright then waits for it forever.
const CLOSE_TIMEOUT_MS = 2000;

// How long the ps fallback in processIds may run before it is killed.
const PS_TIMEOUT_MS = 5000;

// The shared Chromium behind one renderer: launched on first use, and
// replaced after a crash or once it stops answering. When the launch found
// the browser's process group (see PROCESS_LOOKUP_TIMEOUT_MS), retiring or
// closing it ends every process it started. A render reports how it went:
// `rendered` when it finished, `missed` when it passed its deadline. Reports
// about a browser the slot already replaced are ignored.
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

type ProcessIds = { group: number; parent: number };

// The parent and process group of `pid`, from /proc on Linux (the Docker
// image has no ps) and from ps where there is no /proc (macOS); undefined
// when neither answers or the process does not exist.
async function processIds(pid: number): Promise<ProcessIds | undefined> {
  return (await idsFromProc(pid)) ?? (await idsFromPs(pid));
}

async function idsFromProc(pid: number): Promise<ProcessIds | undefined> {
  try {
    const stat = await readFile(`/proc/${String(pid)}/stat`, 'utf8');
    // The command name may hold spaces and parentheses; the fields after its
    // closing parenthesis are state, parent, then process group.
    const [, parent, group] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return processIdsFrom(parent, group);
  } catch {
    return undefined;
  }
}

async function idsFromPs(pid: number): Promise<ProcessIds | undefined> {
  try {
    // Bounded: the lookup runs inside a launch, outside any render's
    // deadline, so a ps that stalls must not hold the queue. SIGKILL, since
    // a stopped ps never acts on the default SIGTERM.
    const { stdout } = await promisify(execFile)('ps', ['-o', 'ppid=,pgid=', '-p', String(pid)], {
      killSignal: 'SIGKILL',
      timeout: PS_TIMEOUT_MS,
    });
    const [parent, group] = stdout.trim().split(/\s+/u);
    return processIdsFrom(parent, group);
  } catch {
    return undefined;
  }
}

function processIdsFrom(
  parent: string | undefined,
  group: string | undefined,
): ProcessIds | undefined {
  const ids = { group: Number(group), parent: Number(parent) };
  return Number.isInteger(ids.group) && ids.group > 0 && Number.isInteger(ids.parent)
    ? ids
    : undefined;
}

// The process group `pid` belongs to, but only when this server started the
// group's leader: Playwright starts Chromium as a child of this process,
// detached, as the leader of a new group. The browser's own id is not always
// the group's: Debian's chromium-headless-shell, and any Chromium started by
// a wrapper script, run the browser under a parent that leads the group.
// Undefined for anything else (this server's own group, a process another
// program started, a browser reached over a remote connection such as
// SELENIUM_REMOTE_URL, whose process id names no local process of ours), so
// a group kill can only reach processes this server started.
export async function ownedProcessGroup(pid: number): Promise<number | undefined> {
  const group = (await processIds(pid))?.group;
  if (group === undefined || group <= 1) {
    return undefined;
  }
  const leader = await processIds(group);
  return leader?.parent === process.pid ? group : undefined;
}

// The browser's process group, or undefined when the lookup fails or the
// group is not one this server started (see ownedProcessGroup).
async function browserProcessGroup(browser: Browser): Promise<number | undefined> {
  const pid = await browserProcessId(browser);
  return pid === undefined ? undefined : ownedProcessGroup(pid);
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
      // Died during the launch: every render already waiting on this launch
      // gets the dead browser and fails; the next acquire launches anew.
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
      await ignoreFailure(
        untilAborted(entry.browser.close(), AbortSignal.timeout(CLOSE_TIMEOUT_MS)),
      );
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
