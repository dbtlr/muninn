import { describe, expect, it } from 'vite-plus/test';

import { untilAborted } from './chromium-launch.js';

describe('untilAborted', () => {
  it('settles as the promise does while the signal stays quiet', async () => {
    await expect(
      untilAborted(Promise.resolve('drawn'), new AbortController().signal),
    ).resolves.toBe('drawn');
    await expect(untilAborted(Promise.reject(new Error('crashed')), undefined)).rejects.toThrow(
      'crashed',
    );
  });

  it('rejects as soon as the signal aborts, without waiting for the promise', async () => {
    const never = Promise.withResolvers<string>().promise;
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 50);

    await expect(untilAborted(never, controller.signal)).rejects.toThrow(/aborted/u);
    await expect(untilAborted(never, AbortSignal.abort())).rejects.toThrow(/aborted/u);
  });
});
