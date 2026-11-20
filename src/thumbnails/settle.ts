import type { BrowserContext } from 'playwright-core';

// Promise helpers both runtimes' thumbnail renderers use to settle a render
// on its deadline without waiting on a browser that may never answer. Type
// imports only: the Worker bundle reaches this file (see capture.ts).

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
