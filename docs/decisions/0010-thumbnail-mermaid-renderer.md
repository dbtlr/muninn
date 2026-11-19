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
- **A second Chromium for Mermaid alone.** It is launched on first use and runs scripts, with
  the JavaScript JIT off (`--js-flags=--jitless`). Its page holds Mermaid's single-file bundle
  (`mermaid/dist/mermaid.min.js`), which the build copies to `dist/public/renderer/mermaid.min.js`.
  Muninn's own `evaluate` call passes the diagram text as a string argument, and Muninn never
  inserts it as markup. Mermaid parses the text and sanitizes its labels under
  `securityLevel: 'strict'`. Nothing else from the artifact reaches this browser. Mermaid draws in
  its dark theme, which matches the renderer's dark color scheme.
- **No network path, at launch and per render.** The network isolation of this browser does not
  depend on Mermaid being free of bugs:
  - The browser is launched with a proxy that nothing listens on, and with `<-loopback>` as its
    only bypass rule. That rule removes Chromium's implicit loopback exception, so every HTTP and
    WebSocket connection fails, including one to this server.
  - `disable_non_proxied_udp` restricts WebRTC to the proxy, so WebRTC has no UDP path. Each
    Chromium build honors one spelling of the switch and ignores the other, so both are passed. Full
    Chromium reads `--webrtc-ip-handling-policy`. `chromium-headless-shell`, which the Docker image
    runs, reads `--force-webrtc-ip-handling-policy`.
  - `--host-resolver-rules=MAP * ~NOTFOUND` makes every hostname fail to resolve. Without it, full
    Chromium looks up the hostname of a TURN-over-TCP server through the host's resolver, which would
    give a script an outbound DNS channel. Nothing in this browser needs a name: the proxy is an IP
    literal, and the page is answered from memory.
  - Launch switches apply to every frame and process, including a sandboxed frame or popup in a
    process of its own.
  - Each render's diagrams are drawn in one fresh context. The context is offline and blocks
    service workers. Its request filter answers the page's own URL, `http://mermaid.invalid/`, from
    memory and aborts every other request. The page has a real origin because Chromium crashes when
    a sandboxed srcdoc frame is added to an `about:blank` page.

  Unit tests pin the settings of both layers. The renderer tests load hostile bundles that try
  fetch, WebSocket, workers, an iframe, a sandboxed frame, a popup, and WebRTC. Each probe confirms
  that it ran, and the tests assert that nothing arrives. A Chromium NetLog test asserts that a TURN
  server hostname causes no DNS transaction. When this decision was recorded, those
  tests also passed with either layer removed, on both full Chromium and `chromium-headless-shell`.
- **The drawings go back to the script-off page.** The renderer replaces each fence with its SVG
  through the isolated world, then takes the screenshot. A script in that markup does not run,
  because the page has scripts off. Any load the SVG declares goes through the artifact browser's
  existing fences. A diagram that Mermaid cannot parse keeps its source.
- **One deadline.** The render's deadline also closes a Mermaid drawing that is still running, and
  stops waiting for the second browser's first launch. A deadline that passes fails the render. A
  launch cut off this way goes on in the background, and the next render uses it.
- **Degrades to source.** If the bundle file is missing or empty, the bundle does not define
  `mermaid`, or the second Chromium fails to launch, the renderer reports this once and stops
  trying. If one drawing fails for another reason, such
  as a crash, the renderer reports it for that preview. Either way the fences show as source, and
  every other part of the preview renders as before.

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
  it under `/assets/renderer/` like every built asset. The Worker uploads it with its static assets
  and serves it at `/renderer/` as well, although nothing there uses it. It is Mermaid's public
  bundle, so serving it exposes nothing.
- Neither browser has Chromium's own sandbox, because the runtime container lacks the kernel
  features it needs. The Mermaid browser therefore runs artifact-supplied diagram text through
  Mermaid with no process sandbox behind it. A Mermaid or DOMPurify flaw that runs script, chained
  with a Chromium engine exploit, would run code on the host outside the network fences. Turning
  the JIT off narrows that surface but does not remove it. Diagrams come from the owner's own
  agents on a trusted network, the same trust boundary the renderer already assumes.
- The Worker has no thumbnail renderer. A future Browser Rendering adapter that draws diagrams must
  meet the same conditions: Muninn's bundle only, diagram text as data, and no network path from
  the page that runs it.
