// Promise helpers for settling thumbnail work on a deadline without waiting
// on a browser that may never answer. capture.ts uses them, so the Worker
// bundle must be able to reach this file: type imports only.

// A browser or context: anything a render opens and must close.
type Closable = { close: () => Promise<void> };

// Closes a render's context or browser, ignoring one that a deadline or
// crash already closed.
export async function closeQuietly(context: Closable): Promise<void> {
  try {
    await context.close();
  } catch {
    // Already closed; nothing to do.
  }
}

// Closes a context or browser whose creation a render stopped waiting for,
// once it exists.
export async function closeWhenCreated(creating: Promise<Closable>): Promise<void> {
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
