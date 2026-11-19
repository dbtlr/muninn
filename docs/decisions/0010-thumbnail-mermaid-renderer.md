---
type: adr
title: ADR-0010 - Thumbnails draw Mermaid diagrams in a separate browser with no network
description: A Markdown artifact's mermaid fences are drawn for its gallery preview in a second Chromium that runs only Mermaid's bundle and has no network path; artifact pages keep scripts off.
status: accepted
created: 2026-11-19
modified: 2026-11-19
---
# ADR-0010 - Thumbnails draw Mermaid diagrams in a separate browser with no network

## Context

The thumbnail renderer screenshots each artifact's page in a headless Chromium on the server host.
That browser runs with scripts off, from launch, in every frame and process. Script-driven
network paths (fetch, WebSocket, workers, popups, WebRTC) each needed a fence of their own, and
each fence left a way to reach loopback services, so scripts were turned off entirely. Mermaid
draws diagrams with script, so a Markdown artifact's mermaid fence showed as its source in the
gallery.

A browser whose scripts are off from launch cannot run any script, not even one Muninn supplies.
The site's own `/assets/mermaid.js` loads each diagram type as a separate chunk over the network,
so it cannot run without network access.

## Decision

- **Artifact pages keep scripts off.** The artifact browser and its fences are unchanged. Only the
  diagram text of a Markdown artifact leaves the artifact page.
- **Markdown only.** The renderer reads the text of each `pre.mermaid` element from a Markdown
  artifact's page through Playwright's isolated world, which works with scripts off. The Markdown
  renderer escapes raw HTML and emits `pre.mermaid` only for a mermaid fence, so each match is a
  fence and its text is the diagram source. HTML artifacts skip this step, so a `pre.mermaid` in an
  author's own markup is never drawn.
- **A second Chromium for Mermaid alone.** It is launched on first use and runs scripts. Its page
  holds Mermaid's single-file bundle (`mermaid/dist/mermaid.min.js`), which the build copies to
  `dist/public/renderer/mermaid.min.js`. Muninn's own `evaluate` call passes the diagram text as a
  string argument. The text is never parsed as HTML, and nothing else from the artifact reaches
  this browser. Mermaid runs with `securityLevel: 'strict'` and the dark theme, which matches the
  renderer's dark color scheme.
- **No network path, at launch and per context.** The safety of this browser does not depend on
  Mermaid being free of bugs:
  - The browser is launched with a proxy that nothing listens on, and with `<-loopback>` as its
    only bypass rule. That rule removes Chromium's implicit loopback exception, so every HTTP and
    WebSocket connection fails, including one to this server.
  - `--webrtc-ip-handling-policy=disable_non_proxied_udp` restricts WebRTC to the proxy, so WebRTC
    has no UDP path. Chromium ignores the content-shell spelling `--force-webrtc-ip-handling-policy`.
  - Launch switches apply to every frame and process, including a sandboxed frame or popup in a
    process of its own.
  - Each drawing gets a fresh context. The context is offline, blocks service workers, and aborts
    every request.
  The renderer tests load a hostile bundle that tries fetch, WebSocket, workers, an iframe, a
  popup, and WebRTC, and assert that nothing arrives. When this decision was recorded, those tests
  also passed with either layer removed.
- **The drawings go back to the script-off page.** The renderer replaces each fence with its SVG
  through the isolated world, then takes the screenshot. A script in that markup does not run,
  because the page has scripts off. Any load the SVG declares goes through the artifact browser's
  existing fences. A diagram that Mermaid cannot parse keeps its source.
- **One deadline.** The render's deadline also closes a Mermaid drawing that is still running.
- **Degrades to source.** If the bundle file is missing, or the second Chromium fails to launch,
  the renderer reports this once. The fences then show as source, and every other part of the
  preview renders as before.

## Considered options

- **Turn scripts on in the artifact browser for Markdown pages only.** The artifact page would run
  script next to the author's content, behind the per-path fences that this design avoids.
  Rejected.
- **Draw diagrams when the artifact is stored and keep the SVGs in the database.** That needs a
  schema change, a renderer version bump to redraw existing artifacts, and a browser on the write
  path. Drawing at thumbnail time keeps `add_artifact` fast and changes no schema.
- **Use the artifact page's own `/assets/mermaid.js`.** It loads diagram code over the network.
  The second browser could not then refuse every request.
- **Use the same Chromium with a script-enabled context.** The artifact browser disables scripts at
  launch, and a launch setting cannot be changed per context. Removing it would reopen the race
  that the launch setting closes for sandboxed frames in their own process.

## Consequences

- A host that renders a Markdown artifact with a diagram runs a second headless Chromium. It is
  kept running until shutdown, and adds its memory to the first.
- The build output includes `dist/public/renderer/mermaid.min.js`, about 3.5 MB. The server serves
  it under `/assets/renderer/` like every built asset, and the Worker uploads it with its static
  assets. It is Mermaid's public bundle, so serving it exposes nothing.
- The Worker has no thumbnail renderer. A future Browser Rendering adapter that draws diagrams must
  meet the same conditions: Muninn's bundle only, diagram text as data, and no network path from
  the page that runs it.
