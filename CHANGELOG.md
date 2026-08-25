# Changelog

All notable changes to Wirebot are documented in this file.

## [Unreleased]

### Changed

- The project now requires Bun 1.4.0 across local development, CI, release builds, and Docker,
  including Bun's v2 text lockfile format.
- Bun's native Markdown and archive APIs now replace the `marked` dependency and the external
  `tar` process previously used to install Codex packages.
- Wirebot is now distributed under the MIT License.
- Codex itself is now the config validator: the Mini App previews check structure only, and
  semantic errors surface from the version-checked `config/batchWrite` at save time. The
  hand-maintained mirror of Codex's config rules is gone, and the feature list comes entirely
  from the app-server instead of a curated catalog.
- Voice transcription is best-effort: any transcription failure now forwards the voice message
  untranscribed with a notice instead of failing the turn.
- Instance-admin command gating moved into the bridge, driven by a connector-computed
  `isAdmin` flag, replacing per-connector enforcement.
- Telegram now shares the connector-common pending-choice and draft-throttle machinery, and
  all three connectors use one `tx:` command-button codec (Discord button payloads changed
  format) and one shared config-UI screen model.
- The settings Mini App client is split into focused modules with self-contained sections;
  the reasoning-effort slider became a segmented control, dropping the
  `@radix-ui/react-slider` and `class-variance-authority` dependencies.
- `codex check --apply` installs protocol bindings in place and relies on git to restore a
  failed upgrade; removals of app-server methods Wirebot never calls are informational
  instead of blocking.

### Removed

- The pre-0.0.27 automation-state migration, the Telegram menu-button read-back verification,
  the symlink-race-proof file open (workspace confinement and snapshotting remain), and
  assorted unused code and injection seams left over from the removed test suites.

## [0.2.1] - 2026-08-07

### Fixed

- Slack Socket Mode no longer reconnects every ~15 seconds in compiled builds. Bun substitutes
  its own undici shim for the undici package, which lacks the ping support that
  `@slack/socket-mode`'s connection health monitor relies on; socket-mode is now routed to the
  real undici implementation through an npm alias.

## [0.2.0] - 2026-08-07

### Added

- A text-only Discord connector built on discord.js, with direct messages, isolated server
  threads, streamed progress, native `/wirebot` commands, approvals, interactive Codex settings,
  scheduled notifications, strict user/admin allowlists, and safe mention suppression.
- A Slack connector over Socket Mode, including direct messages, mention-gated channel threads,
  approvals, file transfer, voice transcription, scheduled notifications, `/wirebot` commands,
  and an interactive Codex settings UI. Slack can run alongside Telegram or as the only connector.

## [0.1.0] - 2026-08-05

Initial Wirebot release, forked from [Telex](https://github.com/sadfun/telex) 0.0.28 and synced with Telex through 0.0.34. The bridge behavior — conversations, scheduled runs, voice transcription, media handling, the settings Mini App — carries over; the product, runtime, and deployment model are new.

### Added

- Headless Codex authentication from the environment: `CODEX_CHATGPT_TOKEN` signs in with a
  ChatGPT access token (workspace id derived from the token's claims, `CODEX_CHATGPT_ACCOUNT_ID`
  as an override; voice transcription included), and `CODEX_API_KEY` signs in with an OpenAI API
  key. Either is applied on every start; when unset, the interactive ChatGPT device-code `/login`
  flow is unchanged. Secrets are delivered over the app-server control channel and stripped from
  agent subprocess environments.
- `/compact` through Codex app-server's native compaction turn, with busy protection and visible
  progress for both manual and Codex-triggered automatic context compaction.
- An authenticated **Schedules** Mini App tab for viewing, creating, editing, pausing, resuming,
  and deleting owner-scoped schedules, with friendly cadence presets, custom RRULEs,
  revision-safe updates, and explicit delete confirmation.
- Telegram's native Mini App back button for nested Skills, Schedules, dialogs, and the
  full-screen editor, with in-page back controls retained outside Telegram.
- A mobile full-screen editor for every multiline Mini App input, with a local draft, character
  count, explicit Apply action, and discard confirmation.
- An authenticated owner can view, update, or delete an explicitly identified schedule from
  another conversation without changing its original delivery or thread binding.
- Unsaved Settings and Schedule drafts are protected when navigating between tabs, going back,
  closing the Telegram Mini App, or unloading the page.

### Changed

- The product is Wirebot: package metadata, `WIREBOT_*` environment variables, `.wirebot` state paths, user-facing strings, and protocol-facing identifiers (app-server `clientInfo`, thread `serviceName`, turn context keys, the dictation `originator`) all use the new name.
- Deployment is an Ubuntu-based container image published to GHCR for `linux/amd64` and `linux/arm64`. The image bundles a rich agent toolset (git, python3, build-essential, ffmpeg, imagemagick, and more), and updating means pulling a new image; a single `/data` volume preserves the workspace, the agent home directory, `/usr/local`, an optional Homebrew prefix, and all Codex state across updates. Codex is told this persistence contract on every turn.
- Inside the container the agent runs as an unprivileged user with passwordless sudo, Wirebot is PID 1 under tini, and Codex's default sandbox is `danger-full-access` — the container boundary is the sandbox. Source runs keep the `workspace-write` default.
- The runtime is Bun: releases are a single compiled executable built with bytecode compilation, minification, and embedded sourcemaps; the app version and Codex pin embed at build time; the Mini App client bundles with `Bun.build`.
- The pinned Codex CLI installs from the npm registry's platform tarball, verified against the registry integrity digest, and Wirebot spawns the native vendored binary directly — Node and npm are no longer needed anywhere. Pinned toolchains (Codex, cloudflared, curl-impersonate) are baked into the image. At runtime only the Codex CLI is downloaded on demand; cloudflared and curl-impersonate are invoked from PATH (the image bakes the pinned builds into a PATH directory), and when absent Wirebot degrades gracefully — no quick tunnel, and voice messages are forwarded untranscribed. Install markers record the platform target so a data volume cannot serve wrong-architecture binaries.
- The pinned voice transport is curl-impersonate 2.0.0 (curl 8.21.0).

### Fixed

- Extract the pinned voice transport without restoring archive ownership on Linux, so
  transcription installs under rootless containers and other restricted runtimes.

### Removed

- The in-place self-update subsystem: the release installer script, versioned release directories, the `current` symlink, rollback, the `/update` command, the exit-75 restart contract, and the `TELEX_UPDATE_*` / `TELEX_INSTALL_DIR` configuration. Container images are immutable; updates are a `docker compose pull` away.
- The mock-heavy vitest unit suite. Wirebot's tests are being rebuilt from scratch as end-to-end
  runs against the actual container image.

Earlier history lives in the [Telex changelog](https://github.com/sadfun/telex/blob/main/CHANGELOG.md).
