// Where the build puts Mermaid's single-file bundle for the thumbnail
// renderer, relative to the static asset root (dist/public): vite.config.ts
// writes it there and server.ts hands its full path to the renderer.
export const THUMBNAIL_MERMAID_BUNDLE = 'renderer/mermaid.min.js';
