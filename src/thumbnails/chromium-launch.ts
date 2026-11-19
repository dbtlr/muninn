// Launch settings both thumbnail browsers share: the artifact renderer
// (playwright-renderer.ts) and the Mermaid renderer (mermaid-renderer.ts).

// TCP port 9 (discard) on loopback: nothing listens there, so proxied
// connections are refused at once rather than hanging.
export const DEAD_PROXY = 'http://127.0.0.1:9';

export const BASE_CHROMIUM_ARGS = [
  // The runtime container runs as an unprivileged user without the kernel
  // features Chromium's own sandbox wants; content is self-authored on a
  // trusted network, so the sandbox is not the boundary here anyway.
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
