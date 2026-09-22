# Changelog

All notable changes to Wirebot are documented in this file.

## [Unreleased]

### Added

- Slack: `@Wirebot new` inside a thread and plain `new` in the bot DM restart the conversation's
  Codex task. The next message there carries the thread's messages from before the restart (the
  recent messages, in a DM) as plain-text context, so the fresh task knows the discussion without
  the previous task's memory. `/wirebot new` and `@Wirebot /new` gained the same carry-over.

## [0.3.3] - 2026-09-21

### Changed

- Updated the bundled Codex CLI from 0.153.3 to 0.155.1 and regenerated the app-server
  protocol bindings. Existing Wirebot integrations remain compatible; this update adds no
  new Wirebot features.

## [0.3.2] - 2026-09-21

### Added

- `install.sh`, a POSIX `sh` install wizard for a fresh Linux server, runnable as a one-liner. It
  installs Docker when missing, signs Codex in with the device-code flow, connects Telegram, Slack,
  or Discord with every token verified against the messenger's API, optionally sets `PUBLIC_URL`
  after checking where the domain points (offering Caddy for automatic HTTPS, or as an origin behind
  Cloudflare's proxy), and starts Wirebot. `--yes` takes everything from flags or the environment
  for unattended installs.
- The installer registers `wirebot-updater.service`: it pulls newer images hourly and recreates
  the containers only after five idle `/healthz` checks in a row, one minute apart.
- `/healthz` reports `busy`, true while a turn, a scheduled run, or a queued message is in flight.

### Changed

- The web app and Telegram Mini App were redesigned around a summary and sub-pages. Settings
  opens as a summary list with usage limits, the current value of each configuration page, the
  remote session toggle, and the runtime controls; Model, Access & approvals, Features,
  Environment, and Remote session are separate pages that each save on their own. Wide browsers
  use a left rail that lists those pages with their current values and shows usage limits, and
  open Skills and Schedules as a list beside the detail; phones drop the tab bar on sub-pages in
  favor of a back link and one bottom action. Skill detail uses Instructions and Files tabs (a
  file tree beside the instructions on desktop), the Skills list is searchable, and schedules are
  rows with a pause switch whose delete action lives in the editor. Detail pages have
  bookmarkable URLs, and the app shows its version in the rail and on the Settings home.
- The browser bundle now ships React's production build.

## [0.3.1] - 2026-09-21

### Changed

- The web app now uses the Wirebot website's logo, favicon, and matching light and dark themes.

### Fixed

- An app-server that exits on its own — an OOM kill, a stray `kill -9`, or a crash — is now
  relaunched automatically with a short back-off (about 50 seconds across five attempts) instead
  of staying down until someone sends `/restart`. Turns wait during the relaunch and resume on the
  new server; `/restart` remains the fallback once the attempts are exhausted.

## [0.3.0] - 2026-09-05

### Added

- A standalone browser app for Settings, Skills, and Schedules, with bookmarkable routes,
  responsive desktop and mobile navigation, and system light/dark themes. Admins sign in using
  a private, one-use link from Telegram's `/web` or Slack/Discord's `/wirebot web` and
  `/wirebot config`; browser sessions preserve the originating messenger's schedule ownership
  and delivery destination. Telegram's existing Mini App authentication remains supported.
- Codex-aware `/healthz` responses report authentication and degraded states from a background
  account check. The HTTP server runs with any connector, including Slack-only and Discord-only
  deployments, and the endpoint remains a liveness check with HTTP 200.
- Container images bundle pre-built skills under `/etc/codex/skills`, including `wirebot-runtime`
  for filesystem, persistence, and installation guidance previously repeated in turn context.

### Changed

- The pinned Codex CLI is now 0.153.3, with regenerated app-server protocol bindings and progress
  labels for the newly supported agent collaboration tools.
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

### Fixed

- Slack and Discord replace the thinking placeholder with the completed answer, posting only
  overflow chunks as new messages. Failed edits fall back to posting the full answer, and turns
  without a final answer retain their latest progress.

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
