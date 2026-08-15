# 🤖 Wirebot

Wirebot brings Codex to your messenger: a full Codex agent you talk to from Telegram, Slack, or Discord, built on a transport layer designed so more messengers can follow.

Think of it as OpenClaw or Hermes Agent with a different philosophy:

* **Built specifically for Codex.** Wirebot runs on Codex's official app server, which makes it exceptionally stable and gives it native support for every Codex feature.
* **No custom harness.** Turns, skills, and tool calls are handled by Codex itself — OpenAI's harness is already very good, so instead of reinventing the wheel, Wirebot focuses on being a better **transport**.
* **No vendor lock-in.** Codex is an open-source harness, and you can proxy any model you want through it.

Out of the box:

* **Rich Telegram I/O** — photos and files in both directions, voice messages with automatic transcription, forwarded and replied-to context, polls and other structured messages.
* **Slack over Socket Mode** — direct messages, channel threads, approvals, files, commands, and scheduled notifications without a public webhook.
* **Text-only Discord** — direct messages, isolated server threads, streaming, approvals, commands, settings, and scheduled notifications with no public endpoint.
* **A real agent experience** — streamed replies and thinking, interactive approvals, persistent Codex threads, private conversations, and guest mentions.
* **Scheduled runs** — describe an automation in plain language and Wirebot keeps it running, following Codex Desktop's scheduled-task model.
* **Settings Mini App** — an authenticated in-Telegram UI for Codex configuration, skills, and schedules.
* **Pinned Codex CLI** — each release bundles the exact compatible Codex version, so nothing depends on a global installation.

## Deployment

> **Don't want to run a server?** [wirebot.ai](https://wirebot.ai) is the hosted version: set up in about 60 seconds, entirely from the browser, without ever touching a config file.

### Run with Docker

Requirements: Docker (or any OCI runtime) and at least one configured Telegram, Slack, or Discord connector.

Create a directory with a `docker-compose.yml`:

```yaml
services:
  wirebot:
    image: ghcr.io/sadfun/wirebot:latest
    restart: unless-stopped
    env_file: .env
    volumes:
      - wirebot-data:/data

volumes:
  wirebot-data:
```

And a `.env` next to it:

```dotenv
TELEGRAM_BOT_TOKEN=123456:replace-me
TELEGRAM_ALLOWED_USER_IDS=123456789
```

`TELEGRAM_ALLOWED_USER_IDS` is a comma-separated list. Messages from other accounts are ignored, including guest-mode mentions. Then:

For Slack instead, follow the [Slack connector setup](docs/slack.md) and set `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `SLACK_ALLOWED_USER_IDS`.

For Discord, follow the [Discord connector setup](docs/discord.md) and set `DISCORD_BOT_TOKEN` and `DISCORD_ALLOWED_USER_IDS`.

```sh
docker compose up -d
```

Open a private chat with the bot and start setup: send `/start` on Telegram or `/wirebot start` on
Slack and Discord. No OpenAI API key is required.

### The machine model

The container filesystem is the **image**: Ubuntu, the wirebot binary, the pinned Codex CLI, and a preinstalled toolset (git, python3, build-essential, ffmpeg, imagemagick, jq, ripgrep, and more). Updating Wirebot means pulling a new image and recreating the container — the image is never modified in place.

Everything personal lives in the **`/data` volume** and survives every update:

| Path               | Contents                                                                          |
|--------------------|-----------------------------------------------------------------------------------|
| `/data/workspace`  | The Codex working directory (`CODEX_WORKSPACE`)                                   |
| `/data/home`       | The agent user's home: dotfiles, SSH keys, git config, `~/.local`, caches         |
| `/data/usr-local`  | `/usr/local` is a symlink here: `make install`, static binaries, pip/npm prefixes |
| `/data/linuxbrew`  | `/home/linuxbrew` is a symlink here: an optional Homebrew installation            |
| `/data/codex-home` | Codex login, `config.toml`, skills, sessions (`CODEX_HOME`)                       |
| `/data/*.json`     | Wirebot conversations, settings, and scheduled runs                               |

The agent runs as an unprivileged user with passwordless sudo, so `apt-get install` works — but apt installs land outside `/data` and disappear on the next image update. Codex is told this contract on every turn: one-off needs can use apt, while software worth keeping belongs in `/usr/local`, the home directory, or Homebrew. Popular missing tools are good candidates for the image itself; open an issue.

Codex's own command sandbox defaults to `danger-full-access` inside the container: the container boundary is the sandbox, and the machine belongs to the agent. Approval policy is separate and stays interactive by default; both are editable in the settings Mini App. This also means anything with access to the container has access to everything in it, including Codex credentials — treat the container and its volume like a personal machine.

### Updates

```sh
docker compose pull && docker compose up -d
```

State lives in the volume, so recreating the container is safe. [Watchtower](https://containrrr.dev/watchtower/) or your orchestrator can automate the pull. Images are tagged `latest` and `X.Y.Z` on GHCR; pin a version tag if you prefer explicit upgrades.

### The settings Mini App URL

To expose the authenticated settings Mini App, either set its public HTTPS origin:

```dotenv
PUBLIC_URL=https://codex.example.com
```

and reverse-proxy that origin to the container's port 8787 (publish it in your compose file), or leave `PUBLIC_URL` unset: Wirebot then opens a [TryCloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) using the bundled pinned cloudflared. Quick tunnels are best-effort — the URL changes on every start and Cloudflare offers no uptime guarantee — so set `PUBLIC_URL` for a persistent deployment. Set `WIREBOT_TUNNEL=off` to never open a tunnel; without a tunnel or `PUBLIC_URL`, Wirebot runs without the `/config` button. The Mini App validates signed Telegram `initData` against the allowlist regardless of how it is exposed.

### Configuration reference

| Variable                    | Default                    | Purpose                                  |
|-----------------------------|----------------------------|------------------------------------------|
| `TELEGRAM_BOT_TOKEN`        | connector-dependent        | Bot token from @BotFather                |
| `TELEGRAM_ALLOWED_USER_IDS` | connector-dependent        | Comma-separated numeric allowlist        |
| `SLACK_BOT_TOKEN`           | connector-dependent        | Slack bot OAuth token (`xoxb-…`)         |
| `SLACK_APP_TOKEN`           | connector-dependent        | Slack Socket Mode token (`xapp-…`)       |
| `SLACK_ALLOWED_USER_IDS`    | connector-dependent        | Member IDs, or `*` for workspace members |
| `SLACK_ADMIN_USER_IDS`      | unset                      | Members allowed to run global commands   |
| `DISCORD_BOT_TOKEN`         | connector-dependent        | Discord application bot token            |
| `DISCORD_ALLOWED_USER_IDS`  | connector-dependent        | Comma-separated Discord user snowflakes  |
| `DISCORD_ADMIN_USER_IDS`    | unset                      | Users allowed to run global commands     |
| `PUBLIC_URL`                | unset                      | Public HTTPS origin for the Mini App     |
| `WIREBOT_TUNNEL`            | `auto`                     | `off` disables the quick-tunnel fallback |
| `TELEGRAM_API_BASE`         | `https://api.telegram.org` | Alternate Bot API server for large files |
| `CODEX_CHATGPT_TOKEN`       | unset                      | ChatGPT access token for headless auth   |
| `CODEX_CHATGPT_ACCOUNT_ID`  | from token                 | Workspace id when the token lacks it     |
| `CODEX_API_KEY`             | unset                      | OpenAI API key for headless Codex auth   |
| `HOST` / `PORT`             | `0.0.0.0` / `8787`         | Mini App listener (container default)    |
| `LOG_LEVEL`                 | `info`                     | `debug`, `info`, `warn`, or `error`      |

## Authenticate Codex

After Wirebot is running, open a private chat with the bot and send `/login`. Follow the device-code link and complete ChatGPT sign-in. Credentials land in the volume's `codex-home`, so restarts and image updates do not require another login. `/status` shows the active account, and `/logout` removes it.

For headless deployments, credentials can come from the environment instead — Wirebot then signs Codex in on every start, so no interactive `/login` is needed, and the environment reasserts itself over any interactive sign-in after a restart. Leave both variables unset to keep the ChatGPT device-code flow. Either way the secret travels to Codex over its control channel and is stripped from agent subprocess environments.

- `CODEX_CHATGPT_TOKEN` — a ChatGPT access token, the same one the normal auth flow produces (`tokens.access_token` in an existing `codex-home/auth.json`). The workspace id is read from the token's claims; set `CODEX_CHATGPT_ACCOUNT_ID` only if the token doesn't carry one. Voice transcription works with this token. Wirebot cannot refresh a token it was handed, so when it expires, supply a fresh one and restart.
- `CODEX_API_KEY` — an OpenAI API key. Note that voice transcription uses ChatGPT credentials and stays unavailable with API-key auth.

The two are mutually exclusive.

Voice messages use that same ChatGPT subscription. Wirebot briefly shows a **Transcribing…** thinking block, sends the OGG recording to ChatGPT's Codex dictation service, and then starts the normal Codex turn with both the transcript and original attachment. The pinned, checksum-verified browser-compatible HTTP transport is bundled in the image.

## Telegram commands

| Command      | Effect                                                                                           |
|--------------|--------------------------------------------------------------------------------------------------|
| `/start`     | Show setup guidance and start sign-in when required.                                             |
| `/new`       | Interrupt the current turn, forget its thread, and start fresh on the next message.              |
| `/back`      | Return to the previously active Codex task.                                                      |
| `/stop`      | Interrupt the running Codex turn.                                                                |
| `/compact`   | Ask Codex to summarize earlier context in the current task; unavailable while a turn is running. |
| `/schedules` | List your scheduled runs and their next execution times.                                         |
| `/status`    | Check app-server connectivity and the current Codex account.                                     |
| `/login`     | Start Codex's ChatGPT device-code login in a private chat.                                       |
| `/logout`    | Sign out through Codex in a private chat.                                                        |
| `/config`    | Open the authenticated settings Mini App in a private chat.                                      |
| `/reload`    | Reload config, MCP servers, and skills through Codex's native app-server APIs.                   |
| `/restart`   | Drain active work and safely restart only the Codex app-server.                                  |
| `/help`      | Show the command list.                                                                           |

Messages that are not commands become `turn/start` requests. Telegram voice messages are transcribed before the turn starts, while their original OGG files remain available to Codex. Photos and supported image files use Codex's native image input. Videos, other audio, documents, animated stickers, and other binary files are downloaded under `.wirebot/attachments` in the Codex workspace and passed as local paths; captions, replies, forwards, polls, contacts, locations, checklists, and Telegram-only structures are preserved as concise text context. Codex commentary drives Telegram's thinking indicator, final-answer deltas drive the draft, approval or user-input requests become inline choices, and native automatic or manual context compaction is shown in the same progress stream.

Every turn also carries connector-derived application context separately from the user's message: it tells Codex that the user is remote (so host-local browser windows and `localhost` links are not user-accessible) and, in the container, describes the persistence contract above.

In the other direction, Wirebot uploads completed Codex image-generation results and regular workspace files explicitly linked in the final answer. JPEG and PNG images, GIF animations, MP4 videos, and MP3 or M4A audio use Telegram's native media methods; everything else is sent as a document. Native-media failures retry as documents, individual upload failures remain visible, and Wirebot snapshots canonically validated files before upload. Markdown links are limited to the configured workspace; structured image-generation outputs are also accepted from Codex's dedicated generated-image directory. Ordinary source edits, code examples, arbitrary paths, and unlinked files are never uploaded automatically.

Telegram's hosted Bot API only allows bots to download files up to 20 MB and upload general files up to 50 MB. Wirebot still forwards the file metadata and a clear limitation notice when a download or upload is unavailable. Set `TELEGRAM_API_BASE` to a [local Bot API server](https://core.telegram.org/bots/api#using-a-local-bot-api-server) to remove the download limit and support larger uploads.

## Slack connector

Wirebot can additionally bridge Codex into Slack over [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode) — no public URL required. Direct messages stream progress like the Telegram private chat; in channels the bot answers mentions in threads, with each thread acting as its own Codex conversation. Approvals arrive as buttons, files flow in both directions, and commands are available as `/wirebot <subcommand>` (Slack reserves bare `/new`-style messages for its own slash-command system). Scheduled runs created from Slack notify back into the originating channel or thread.

Set `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `SLACK_ALLOWED_USER_IDS` together to enable it. [docs/slack.md](docs/slack.md) walks through creating the Slack app from a pasteable manifest, collecting both tokens, and first steps. The settings Mini App stays Telegram-only because it authenticates through Telegram `initData`.

## Discord connector

Wirebot connects through the Discord Gateway with [discord.js](https://github.com/discordjs/discord.js), so it needs no inbound webhook or public URL. Direct messages are ordinary Codex conversations. In a server, mention the bot in a text channel and Wirebot creates a dedicated public thread when Discord permissions allow it; subsequent messages in that bot-owned thread need no repeated mention. Mentions inside existing threads keep that thread as the conversation boundary. Native `/wirebot` commands, streamed progress, approval buttons, interactive Codex settings in DMs, and scheduled notifications all use the same persistent Codex tasks as the other connectors.

The connector is deliberately text-only. It does not download Discord attachments, stickers, or polls, and it never uploads generated files; both inbound and outbound omissions are stated in the conversation. Model-authored mentions and link previews are suppressed on every outbound create and edit. Set `DISCORD_BOT_TOKEN` and `DISCORD_ALLOWED_USER_IDS` together to enable it, then follow [docs/discord.md](docs/discord.md) for the Developer Portal intent, invite permissions, user IDs, and first run.

## Scheduled runs

Ask Codex naturally, for example, “Every weekday at 9, check this project for failed CI runs” or “Revisit this task every hour and notify me only if something changed.” Wirebot exposes a host-managed `automation_update` tool to new Codex tasks and stores each schedule with an explicit time zone. A task created before upgrading does not have that tool in its persisted definition; send `/new` once before asking it to create or edit schedules. `/schedules` remains available for viewing them.

The Mini App's **Schedules** tab lists every schedule owned by the authenticated user, including schedules created in other topics. It can create fresh-task schedules with friendly minute, hourly, daily, weekday, and weekly presets or a custom RRULE; existing schedules can be edited, paused, resumed, or deleted with revision checks and confirmation for destructive actions.

The recurrence engine accepts a bounded RRULE subset covering minutely, hourly, daily, and weekly schedules. It rejects multi-line, unusually dense, or computationally expensive rules instead of allowing schedule evaluation to stall the bridge.

Scheduled runs follow the [Codex Desktop scheduled-task model](https://developers.openai.com/codex/app/automations):

- A cron run starts a fresh persistent Codex task for each occurrence. A heartbeat revisits the Codex task in which it was created.
- When the scheduler claims work, an active or waiting user message makes it defer and retry. If an unattended run has already started, a later message shows a queued status and begins as soon as that run finishes.
- Heartbeats can suppress unimportant results. Cron results notify by default, and delivery failures are recorded without rerunning already completed work.
- Each schedule gets a small durable memory file under the workspace's `.wirebot/automations` directory, which the run reads and may update.

Notifications deliberately do not change the active task. Your next ordinary message still goes to the task you were already using. Replying to a scheduled notification also stays in that task, but Wirebot supplies the complete stored result as additional context even when the provider split or truncated the visible message. **Continue this run** explicitly switches to the notification's source task when the conversation is idle; `/back` returns to the previous task.

Scheduling and delivery state use opaque provider references rather than provider-specific message or chat fields. Telegram, Slack, and Discord each define their own destination and message identifier formats without changing the scheduler.

Wirebot retains the latest 100 run and notification records for each schedule so local state stays bounded. Since there is no systemd in the container, processes the agent starts do not survive restarts — scheduled runs are the supported way to re-establish or monitor long-lived work.

The service must be running when work becomes due; this is not a cloud scheduler and it does not wake a powered-off machine.

### The one custom-harness exception

Wirebot's design rule is to use Codex's native app-server behavior instead of building a custom agent harness. The scheduled-runs engine is the one exception because Codex Desktop already implements scheduling in its host application rather than in Codex CLI. Wirebot mirrors that approach nearly 1:1: the host claims due work, applies foreground priority, persists run and notification state, and asks Codex to execute normal turns. As soon as Codex CLI or app-server provides native cron ownership, Wirebot will switch to it immediately and retire this engine.

## Settings Mini App

The Mini App is pinned to the bot's **Settings** menu button when its public URL is available; `/config` remains an equivalent entry point. At startup Wirebot reconciles both Telegram's default button and each allowlisted private chat, so a stale chat-specific command-menu override cannot hide the Mini App. It uses source-owned UI components styled with Tailwind and accepts only signed Telegram `initData` from allowlisted private users. Its tab bar keeps **Settings** first, **Skills** second, and adds a **Schedules** screen for owner-scoped schedule management. The Skills screen lists every enabled skill from Codex's native `skills/list` response. Opening a skill shows its `SKILL.md` instructions and a read-only browser for bundled scripts, references, images, and other files. Skill paths remain confined to that skill's directory, and oversized files are not loaded into the browser.

Inside Telegram, nested Mini App screens use the native header back button; ordinary browser
rendering keeps the in-page back controls. Every multiline input can open a focused full-screen
editor with a local draft and explicit Apply action. Unsaved Settings and Schedule drafts are
protected on back navigation, tab changes, browser unload, and Telegram Mini App close.

The settings tab includes a default-on remote session context toggle and covers the everyday settings from Codex's [basic configuration guide](https://learn.chatgpt.com/docs/config-file/config-basic), including models, reasoning, approval policy, permission profiles, sandboxing, web search, shell environment, and supported feature flags. Turning remote session context off stops Wirebot from adding its connector-aware instructions to Codex turns.

Choices come from the running app-server and active configuration layers instead of a handwritten catalog. Codex itself is the validator: a save is a version-checked `config/batchWrite`, so all changes either pass Codex validation and land together or leave `config.toml` untouched. The app-server runs with `--strict-config`, so unknown configuration keys fail loudly.

Wirebot keeps the running Codex process synchronized using the [app-server mechanisms designed for this purpose](https://learn.chatgpt.com/docs/app-server#api-overview):

- Mini App saves hot-reload the effective user configuration and carry supported model, approval, and reasoning choices into the next turn.
- External edits to config files are applied on demand: send `/reload` or press **Apply changes** in the Mini App to run the same reconciliation. An invalid edit leaves the last healthy runtime active and shows a degraded status.
- Skills use Codex's built-in watcher plus a forced `skills/list` refresh. Explicit `$skill-name` mentions are sent as native skill inputs.
- MCP definitions use `config/mcpServer/reload`. Codex queues refreshed MCP state for loaded threads, so it becomes active on their next turn.

The runtime card in the Mini App shows the current outcome and offers **Apply changes** and **Restart Codex**. `/reload` and `/restart` provide the same private-chat controls. Restart is the fallback for startup-only state: Wirebot pauses new turns, lets active turns finish, restarts its child app-server with the same `CODEX_HOME`, reloads its resources, and lazily resumes persisted thread IDs. It does not restart the messaging bridges or discard authentication and conversation history.

## Source development

Requirements: [Bun](https://bun.com) 1.3 or newer.

```sh
git clone https://github.com/sadfun/wirebot.git
cd wirebot
bun install
cp .env.example .env
bun run dev
```

Development commands:

```sh
bun run check      # typecheck + biome
bun run compile    # single-file executable in dist/wirebot
docker build .     # the release image
```

Source runs keep Codex's `workspace-write` sandbox default and store state under `./.wirebot`. They download the pinned Codex CLI on first start; cloudflared and curl-impersonate are invoked from PATH, where the container image bakes the pinned builds. Without cloudflared (or `PUBLIC_URL`) the quick tunnel is skipped, and without curl-impersonate voice messages are forwarded to Codex untranscribed. The compiled executable embeds the app version, the Codex pin, and bytecode with maximum optimizations; Mini App assets and the pinned toolchains are baked into the image alongside it.

The handwritten application is strict TypeScript. Messaging transports depend only on `src/core/channel.ts`; Telegram, Slack, and Discord implement the same contract.

### Codex protocol updates

Application updates and Codex protocol updates are intentionally separate. Each Wirebot release bundles the exact compatible Codex CLI version recorded in `codex.version`, fetched directly from the npm registry's platform tarball and verified against the registry integrity digest — no Node or npm involved.

Maintainers can test a newer Codex protocol from a source checkout:

```sh
# Generate the candidate protocol and compile Wirebot against it.
bun run codex:check

# Apply it only after compatibility checks succeed.
bun run codex:update
```

The check uses the candidate binary's `app-server generate-ts` output and compares the RPC surface; removed methods are never applied. Applying installs the bindings, typechecks the repository against them, and rolls the bindings back if the typecheck fails.

### Publishing a release

1. Update the version in `package.json`.
2. Run `bun run check` and `bun run compile`.
3. Push a matching tag such as `v0.2.0`.

The Release workflow verifies the tag, runs the checks, builds the `linux/amd64` and `linux/arm64` images, and pushes them to `ghcr.io/sadfun/wirebot` tagged with the version and `latest` (prereleases skip `latest`).

## Uninstall

```sh
docker compose down
```

Removing the `wirebot-data` volume permanently deletes conversations, Codex configuration and login state, the workspace, and everything the agent installed into the persistent paths.

## License

Wirebot is released under the [Functional Source License 1.1 with an MIT future license](./LICENSE.md). Each published version becomes available under MIT two years after its release date.
