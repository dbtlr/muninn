// Modules that exist only for the Node profile (ADR-0009). workerd stubs
// node:sqlite and provides node:fs, so a Worker that loads one of these still
// starts, and a test under workerd does not notice; only the built bundle
// shows that the Worker reached them. scripts/check-worker-bundle.ts checks
// the built bundle for them, and vite.config.ts bars them from the shared
// thumbnail code. The list lives in src/ because the Docker builder stage
// copies only src/ and the config files.
export const FORBIDDEN_MODULES = [
  'node:sqlite',
  'node:fs',
  'node:fs/promises',
  'umzug',
  '@hono/node-server',
  'playwright-core',
] as const;
