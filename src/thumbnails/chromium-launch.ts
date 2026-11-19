import type { BrowserContext } from 'playwright-core';

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
