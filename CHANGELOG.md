# Changelog

All notable changes to Wirebot are documented in this file.

## [0.1.0] - Unreleased

Initial Wirebot release, forked from [Telex](https://github.com/sadfun/telex) 0.0.28. The bridge behavior — conversations, scheduled runs, voice transcription, media handling, the settings Mini App — carries over; the product, runtime, and deployment model are new.

### Changed

- The product is Wirebot: package metadata, `WIREBOT_*` environment variables, `.wirebot` state paths, user-facing strings, and protocol-facing identifiers (app-server `clientInfo`, thread `serviceName`, turn context keys, the dictation `originator`) all use the new name.
- Deployment is an Ubuntu-based container image published to GHCR for `linux/amd64` and `linux/arm64`. The image bundles a rich agent toolset (git, python3, build-essential, ffmpeg, imagemagick, and more), and updating means pulling a new image; a single `/data` volume preserves the workspace, the agent home directory, `/usr/local`, an optional Homebrew prefix, and all Codex state across updates. Codex is told this persistence contract on every turn.
- Inside the container the agent runs as an unprivileged user with passwordless sudo, Wirebot is PID 1 under tini, and Codex's default sandbox is `danger-full-access` — the container boundary is the sandbox. Source runs keep the `workspace-write` default.
- The runtime is Bun: releases are a single compiled executable built with bytecode compilation, minification, and embedded sourcemaps; the app version and Codex pin embed at build time; the Mini App client bundles with `Bun.build`.
- The pinned Codex CLI installs from the npm registry's platform tarball, verified against the registry integrity digest, and Wirebot spawns the native vendored binary directly — Node and npm are no longer needed anywhere. Pinned toolchains (Codex, cloudflared, curl-impersonate) are baked into the image; source runs still download them on demand. Install markers record the platform target so a data volume cannot serve wrong-architecture binaries.

### Removed

- The in-place self-update subsystem: the release installer script, versioned release directories, the `current` symlink, rollback, the `/update` command, the exit-75 restart contract, and the `TELEX_UPDATE_*` / `TELEX_INSTALL_DIR` configuration. Container images are immutable; updates are a `docker compose pull` away.

Earlier history lives in the [Telex changelog](https://github.com/sadfun/telex/blob/main/CHANGELOG.md).
