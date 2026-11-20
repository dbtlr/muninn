---
type: adr
title: ADR-0009 - Muninn also runs as a Cloudflare Worker, from the same package, with owner auth required
description: A second deployment profile runs Muninn as a Cloudflare Worker on D1, R2, and Static Assets. Both profiles share one package and one core and differ only in their entry point and adapters. The Worker always requires the owner password.
status: accepted
created: 2026-10-27
modified: 2026-11-20
---
# ADR-0009 - Muninn also runs as a Cloudflare Worker, from the same package, with owner auth required

## Context

Muninn runs on Node, with SQLite and files on disk, usually in Docker on a home server. An owner
without a server wants a hosted personal instance. Cloudflare Workers can host one for little or
nothing, but a Worker has no filesystem, no `node:sqlite`, no long-lived process, and no trusted
network.

## Decision

- **Two deployment profiles, one core.** The Node profile (`src/server.ts`) composes SQLite and
  filesystem adapters. The Cloudflare profile (`src/worker.ts`) composes D1, R2, and Workers Static
  Assets. Routes, pages, MCP, auth, secrets, rendering, and the SQL are shared. Each adapter passes
  the same contract tests under Node and under workerd. A profile is fixed by its entry point;
  there is no runtime backend setting.
- **One package with two entry points.** The shared core may import only what workerd provides
  under `nodejs_compat`. workerd stubs some Node modules, such as `node:sqlite`, so loading the core
  in a test is not enough: a check on the built Worker bundle rejects Node-only imports.
- **The Worker requires the owner password.** A Worker has no trusted network, so the opt-in of
  [ADR-0001](0001-opt-in-owner-auth.md) does not apply: without `MUNINN_OWNER_PASSWORD` the Worker
  serves nothing but an error. It also requires `MUNINN_PUBLIC_BASE_URL`, because Node's default
  follows `MUNINN_PORT`, which means nothing on a Worker. Until both are valid, every request that
  reaches the Worker gets a plain-text `500` that names the setting but not its value, and the
  scheduled handler fails. Static Assets still serve the built files, such as `/app.css`,
  `/secret.js`, `/chunks/*`, and the icons, because they answer before the Worker runs. The Node
  profile keeps the opt-in unchanged.
- **Each request composes its own services.** The Worker builds the services and the app from the
  request's bindings, with no state kept in the isolate between requests. Composing is only object
  construction, and workerd does not let one request safely await I/O that another request
  started, which a shared signing-key cache would do. One exception: the Browser Rendering
  renderer keeps the ID of the session it launched, and that session's count of missed deadlines,
  in the isolate, so later requests reuse the session. An ID and a count are not I/O objects, so
  no request awaits I/O that another started: each request opens its own connection to the
  session.
- **The login limit reads `CF-Connecting-IP`.** Cloudflare sets that header itself, so the
  per-client limit of [ADR-0005](0005-per-client-login-limit.md) needs no operator setting on the
  Worker, and the Worker does not read `MUNINN_CLIENT_ADDRESS_HEADER`.
- **Stored Markdown renderings live in R2.** A D1 row holds at most about 2 MB, and an artifact may
  be 10 MB, so its rendering can outgrow a row. On the Worker, a Markdown artifact's stored rendering
  always goes to R2, and D1 keeps only its small fields. The rendering is written before its row,
  the same order as content before metadata. A missing rendering is a cache miss and is rendered
  again. Embed templates ([ADR-0003](0003-signed-embed-urls.md)) stay in D1: they hold reference
  positions, not HTML, and stay far below the row limit. The Node profile keeps renderings in
  SQLite.
- **Periodic work runs from a Cron Trigger.** The one-time secret sweep that Node runs on a timer
  runs from the Worker's scheduled handler, every 10 minutes.
- **Static Assets serve the Vite build.** `dist/public` holds only the stylesheet, the client
  scripts, and the icons, so it is served without auth. Static Assets serve its files at the site
  root before the Worker runs, so on the Worker each built file is reachable both at the root, such
  as `/app.css`, and under `/assets/`, where the Node profile serves it. The root paths are
  harmless, because everything in `dist/public` is public. The Worker maps `/assets/*` and
  `/favicon.ico` onto the same files, as the Node profile does.

## Considered options

- **Workspace packages for the core, Node, and Cloudflare.** Each package would need its own build
  and exports, and the core would have no consumer besides the two entries. The bundle check
  enforces the same boundary with less structure.
- **Spill renderings to R2 only above a size threshold.** It saves an R2 read for small artifacts,
  at the cost of two storage paths for one kind of data.
- **Compose once per isolate.** The signing-key cache would then last across requests, but
  requests would share in-flight D1 reads, and a request could be served from bindings other than
  its own.
- **Cap artifact size on the Worker.** It is the simplest option, but the two profiles would then
  accept different artifacts.

## Consequences

- Workers Paid is the supported plan. On the free plan, a request is limited to 10 ms of CPU, and
  rendering a Markdown artifact of a few kilobytes or more when it is saved exceeds that.
- Gallery previews on the Worker come from Cloudflare Browser Rendering, through
  `@cloudflare/playwright`, under the same render rules as Node (`src/thumbnails/capture.ts`). The
  renderer is `src/thumbnails/browser-rendering-renderer.ts`. Until the Worker calls it from a
  queue or a scheduled run, every card shows its stored preview or the drawn placeholder. Browser
  Rendering has its own limits on each plan, such as launches per minute and concurrent sessions.
- Worker previews do not draw Mermaid diagrams yet: a Markdown artifact's `mermaid` fences show as
  source until task ART-102 brings the diagram renderer of
  [ADR-0010](0010-thumbnail-mermaid-renderer.md) to the Worker.
- Browser Rendering cannot turn scripts off at launch, the first obligation that `capture.ts`
  names. Only the per-context switch turns them off, and a sandboxed `srcdoc` frame in its own
  process can run script before that switch applies. Such a script runs in a browser that holds no
  owner session cookie and no API key, only signed URLs: the rendered artifact's own, and those of
  the artifacts its page embeds, which the app signs for each view. Each grants a `GET` of one
  artifact that the author chose to show. Every Worker route that changes state needs the owner's
  session (`/logout`, `/keys*`, `/secrets/new`), an API key (`/mcp`), or an unguessable token or
  key (`/s/upload/*`, `/s/download/*`, `/s/*/reveal`). `POST /login` is the only one open to anyone,
  and [ADR-0005](0005-per-client-login-limit.md) limits it per client address and in total. So the
  script reaches only what an anonymous internet client reaches.
- Browser Rendering's network fence is hostname-only, the second obligation's gap. Each session is
  launched with guardrails, an egress allowlist that Cloudflare latches for the session's life, set
  to the host of `MUNINN_PUBLIC_BASE_URL` alone. Guardrails match hostnames, not ports, methods, or
  paths, and the request filter in `capture.ts` cannot see WebSockets. On `workers.dev` or a custom
  domain bound to the Worker, every port that Cloudflare serves for the hostname reaches this same
  Worker, so admitting every port reaches no other service. A Workers route that shares its
  hostname with another origin server would expose that origin's `GET` surface to a script that
  wins the race. The supported deploys are therefore a custom domain or `workers.dev`, not a route.
- Browser Rendering limits launches per minute, and a launch takes about a second, so the renderer
  reuses one session across renders, and across Worker invocations within an isolate. Only the
  session's ID and its count of missed deadlines are kept in the isolate between requests, never a
  connection. The renderer reuses only a session it launched itself: the account's session list
  may hold a session that another Worker launched without guardrails. As on Node, three renders in
  a row that pass their deadline retire the session, which the renderer then ends over CDP. A
  reconnect that fails or takes longer than 10 seconds falls through to a launch, as does a
  connection found dropped before a render. A refused launch, a launch that takes longer than 10
  seconds, or a session lost during a render rejects with `RenderUnavailableError`, so the caller
  can retry later. A session counts as lost only when Playwright reports it disconnected, never by
  an error's message; when a render fails and its session is lost too, the loss wins, since a
  retry reconnects or launches and an error the artifact itself causes then comes back plain. Any
  other failure, including a render that passes its deadline, rejects with a plain error. A render
  that resolves `null` still means the artifact has no preview.
- A Worker request that signs or checks a URL reads the hour's signing key from D1, rather than
  from a process cache that lasts the hour as [ADR-0004](0004-hourly-url-signing-keys.md) describes
  for Node.
- `pnpm worker:check` builds the Worker without deploying it and fails if the bundle imports
  `node:sqlite`, `node:fs`, `umzug`, `@hono/node-server`, or `playwright-core`. CI runs it.
- `wrangler deploy` replaces the Worker's variables with those in `wrangler.jsonc`, which lists
  none, so both settings are set as secrets.
