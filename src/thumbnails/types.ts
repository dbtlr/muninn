import type { MediaType } from '../artifacts/media.js';

// What a renderer needs to produce one preview: the artifact's own URL on
// this server, so html is rendered exactly as a visitor sees it, md/txt come
// through the app's own page, and images load with their real headers.
export type ThumbnailTarget = { id: string; mediaType: MediaType; url: string };

export type ThumbnailRenderer = {
  close: () => Promise<void>;
  // Resolves to encoded JPEG bytes, or null when this kind cannot be
  // rendered or the server did not serve the artifact (the gallery then
  // keeps its drawn placeholder).
  render: (target: ThumbnailTarget) => Promise<Uint8Array | null>;
};

export type ThumbnailStore = {
  has: (id: string) => Promise<boolean>;
  read: (id: string) => Promise<Uint8Array | null>;
  remove: (id: string) => Promise<void>;
  write: (id: string, bytes: Uint8Array) => Promise<void>;
};

// Draws a Markdown artifact's mermaid fences for its preview, in a browser of
// its own with no network path (ADR-0010). The Node implementation is
// mermaid-renderer.ts; capture.ts swaps the drawings into the page.
export type MermaidRenderer = {
  close: () => Promise<void>;
  // One SVG per diagram text, in order. An entry is null where Mermaid could
  // not draw that text, and every entry is null while Mermaid rendering is
  // disabled (the bundle or Chromium is missing; reported once). Rejects when
  // the signal aborts, and when the drawing itself fails.
  render: (texts: readonly string[], signal?: AbortSignal) => Promise<(string | null)[]>;
};
