# syntax=docker/dockerfile:1

# Build stage: compiles the Mini App assets, the wirebot executable, and
# downloads the pinned toolchains for the target architecture. Runs on the
# build platform and cross-compiles, so no emulation is needed here.
FROM --platform=$BUILDPLATFORM oven/bun:1.3 AS build
ARG TARGETARCH
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY codex.version tsconfig.json ./
COPY scripts ./scripts
COPY src ./src

RUN bun run build
RUN bun build --compile --minify --bytecode --sourcemap \
      --define WIREBOT_COMPILED=true \
      --target="bun-linux-$([ "$TARGETARCH" = "arm64" ] && echo arm64 || echo x64)" \
      src/cli/main.ts --outfile dist/wirebot
RUN bun scripts/bake-toolchains.ts /toolchains "$([ "$TARGETARCH" = "arm64" ] && echo arm64 || echo x64)"

# Runtime stage: an Ubuntu machine for the agent. Wirebot and its pinned
# toolchains live in the image under /opt/wirebot; everything the user should
# keep across image updates lives in the /data volume, with /usr/local and
# /home/linuxbrew symlinked into it.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini ca-certificates curl wget git git-lfs openssh-client gnupg \
      sudo locales tzdata file less procps psmisc htop \
      nano vim-tiny \
      unzip zip tar gzip bzip2 xz-utils zstd \
      jq ripgrep sqlite3 rsync \
      dnsutils iputils-ping netcat-openbsd \
      python3 python3-pip python3-venv pipx \
      build-essential pkg-config \
      ffmpeg imagemagick \
    && rm -rf /var/lib/apt/lists/* \
    && locale-gen en_US.UTF-8

# The agent user owns /data and has passwordless sudo; the Wirebot install
# under /opt/wirebot stays root-owned so the agent cannot corrupt it.
RUN userdel -r ubuntu \
    && useradd --uid 1000 --no-create-home --home-dir /data/home --shell /bin/bash wirebot \
    && echo "wirebot ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/wirebot \
    && chmod 0440 /etc/sudoers.d/wirebot

# Persistable system surfaces: /usr/local's image content becomes a seed that
# the entrypoint copies into the volume on first boot.
RUN mkdir -p /opt/wirebot/seed \
    && mv /usr/local /opt/wirebot/seed/usr-local \
    && ln -s /data/usr-local /usr/local \
    && ln -s /data/linuxbrew /home/linuxbrew

COPY --from=build /app/dist/wirebot /opt/wirebot/bin/wirebot
COPY --from=build /app/dist/miniapp/public /opt/wirebot/miniapp
COPY --from=build /toolchains /opt/wirebot/toolchains
COPY docker/entrypoint.sh /opt/wirebot/bin/entrypoint.sh
RUN chmod 0755 /opt/wirebot/bin/wirebot /opt/wirebot/bin/entrypoint.sh \
    # The bake runs as root; the agent user only needs to read and execute.
    && chmod -R a+rX /opt/wirebot/toolchains /opt/wirebot/miniapp /opt/wirebot/seed

ENV WIREBOT_CONTAINER=1 \
    WIREBOT_DATA_DIR=/data \
    CODEX_WORKSPACE=/data/workspace \
    WIREBOT_TOOLCHAINS_DIR=/opt/wirebot/toolchains \
    WIREBOT_ASSETS_DIR=/opt/wirebot/miniapp \
    HOME=/data/home \
    HOST=0.0.0.0 \
    CODEX_CHECK_UPDATES=false \
    LANG=en_US.UTF-8 \
    PATH=/opt/wirebot/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

EXPOSE 8787
ENTRYPOINT ["tini", "--", "/opt/wirebot/bin/entrypoint.sh"]
CMD ["start"]
