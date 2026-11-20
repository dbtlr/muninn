# Two-stage build: full workspace install to run the build, then a slim
# prod-only runtime image carrying just dist/.
#
# Layout matters here: src/static-files.ts and src/data-dir.ts resolve the static
# asset root and the default data dir relative to their own module location
# (one level below the app root), not process.cwd() — see the comments in
# those files. tsdown bundles everything into a single dist/server.js, so at
# runtime that file's location IS "one level below the app root". Keep
# WORKDIR and the COPY layout below such that dist/server.js ends up at
# <WORKDIR>/dist/server.js and dist/public/ stays alongside it.

FROM node:26-trixie-slim AS builder
WORKDIR /app
# apt runs without a terminal during the build; this keeps debconf from
# trying interactive frontends. ARG does not reach the running container.
ARG DEBIAN_FRONTEND=noninteractive
# Vite+ builds its HTTP client from the system CA store, which Debian slim
# leaves out, and panics without one.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN VITE_GIT_HOOKS=0 pnpm install --frozen-lockfile
COPY tsconfig.json vite.config.ts ./
COPY src ./src
RUN pnpm run build

FROM node:26-trixie-slim AS runner
WORKDIR /app
ARG DEBIAN_FRONTEND=noninteractive
RUN corepack enable

# Gallery previews are screenshots taken by a headless Chromium driven over
# CDP by playwright-core (src/thumbnails/playwright-renderer.ts). Debian's
# chromium-headless-shell is Chromium's headless-only build: it draws in
# software, without a display server or GPU.
# Debian's Chromium packages still depend on Mesa's GPU drivers, which bring
# LLVM (about 250 MB together). The headless shell links only libgbm, and
# libgbm loads the drivers just for GPU work, so they are removed by exact
# name after the install. apt then reports their dependents as broken: do not
# apt-get install into this image. `dpkg --remove` skips a package that is not
# installed, so `dpkg --status` first fails the build if Debian renames one,
# and the `find` after it fails the build if LLVM or gallium files remain (a
# renamed package behind a transitional one), rather than shipping the
# drivers again.
# tini is the image's init (see ENTRYPOINT): it reaps the zombies a crashed
# Chromium's children become once they are reparented away from it, which
# node does not do, and it passes signals on to node.
# Inter is the sans face (close to the macOS system font the pages are
# designed on), DejaVu covers the mono and fallback glyphs, Noto the emoji.
# Chromium resolves the CSS generic families through fontconfig, and without
# the aliases below `system-ui` matches nothing in particular and numerals can
# come out of the emoji font; the aliases pin the generics Chromium really
# asks fontconfig for (system-ui, sans-serif, monospace) to a real face. The
# CSS ui-* names are not generics on Linux and fall through to these. The
# file sorts before Debian's 60-latin.conf, so its preferences come first.
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium-headless-shell ca-certificates tini \
    fonts-inter fonts-dejavu-core fonts-noto-color-emoji \
  && dpkg --status libgl1-mesa-dri mesa-libgallium libllvm19 libz3-4 > /dev/null \
  && dpkg --remove --force-depends libgl1-mesa-dri mesa-libgallium libllvm19 libz3-4 \
  && test -z "$(find /usr/lib \( -name 'libLLVM*' -o -name 'libgallium*' \) -print -quit)" \
  && rm -rf /var/lib/apt/lists/* \
  && printf '%s\n' \
    '<?xml version="1.0"?>' \
    '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">' \
    '<fontconfig>' \
    '  <alias><family>system-ui</family><prefer><family>Inter</family></prefer></alias>' \
    '  <alias><family>sans-serif</family><prefer><family>Inter</family><family>DejaVu Sans</family></prefer></alias>' \
    '  <alias><family>monospace</family><prefer><family>DejaVu Sans Mono</family></prefer></alias>' \
    '</fontconfig>' \
    > /etc/fonts/conf.d/51-muninn-generics.conf

ENV NODE_ENV=production
ENV MUNINN_PORT=4242
ENV MUNINN_DATABASE_PATH=/app/data/database/artifacts.db
ENV MUNINN_FILES_DIR=/app/data/files
ENV MUNINN_THUMBS_DIR=/app/data/thumbs
ENV MUNINN_CHROMIUM_PATH=/usr/bin/chromium-headless-shell
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# The runtime needs node_modules only: pnpm's package store and corepack's
# copy of pnpm (about 230 MB together) stay out of the layer.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
  && rm -rf /root/.cache /root/.local/share/pnpm
COPY --from=builder /app/dist ./dist
# The SQL migrations are read at startup from <app root>/migrations.
COPY migrations ./migrations
RUN mkdir -p /app/data/database /app/data/files /app/data/thumbs && chown -R node:node /app/data

# Run as the non-root `node` user baked into the base image (uid/gid 1000)
# rather than root. Everything under /app is read-only for this process except
# the persistence paths, which are prepared for independent named volumes.
# Host bind mounts retain host ownership and must be writable by this user; the
# Docker operator probes that access before replacing a running container.
# /app/data/thumbs holds derived previews only: without a mount they live in
# the container layer and are re-rendered on the next start.
USER node

EXPOSE ${MUNINN_PORT}

# Liveness probe: hits `/` so `docker ps` and any orchestrator that gates on
# container health can see the server is actually bound. Debian slim has no
# wget or curl, so Node's fetch does the request; it follows the redirect to
# /login when owner login is on.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch(`http://localhost:${process.env.MUNINN_PORT}/`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# -s registers tini as a subreaper, so it still reaps (and does not warn that
# it cannot) when another init such as `docker run --init` is PID 1 above it.
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["node", "dist/server.js"]
