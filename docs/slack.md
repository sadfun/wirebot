# Slack connector

Wirebot can bridge Codex into Slack alongside Telegram. The connector uses
[Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode), so it
needs no public URL, webhook endpoint, or reverse proxy — the bridge dials out
to Slack exactly like the Telegram long-polling connection.

What works in Slack:

- Direct messages with the bot: send a message, watch live progress, get the
  final answer, exchange file attachments.
- Channels and group DMs: mention the bot (`@Wirebot fix the build`) and it
  answers in a thread. Every message addressed to the bot needs a mention —
  including follow-ups in the same thread — so human discussion around it
  stays untouched. Each thread is its own Codex conversation with persistent
  context. When first mentioned inside an existing thread, the bot reads the
  earlier thread messages (up to 100, newest-biased) as context, so it
  understands the discussion it was called into.
- Approvals: when Codex asks for confirmation, the question arrives as Slack
  buttons.
- Scheduled runs: results are delivered to the channel or thread that created
  them, with a Continue button.
- Commands: `/wirebot new`, `/wirebot status`, and friends (Slack reserves plain
  `/new`-style messages for its own slash commands, so Wirebot registers a single
  `/wirebot` command with subcommands).

When Codex creates a report, archive, image, or another deliverable, Wirebot can
upload it into the same Slack DM or thread. The connector-aware system context
instructs Codex to link the workspace-local deliverable in its final answer;
Wirebot validates and snapshots that file before uploading it with Slack's
`files:write` permission. Local links used only as code references are not
uploaded.

The settings Mini App remains Telegram-only because it authenticates through
Telegram. Everything else — including `/wirebot login` for the ChatGPT sign-in —
works from Slack.

## 1. Create the Slack app

1. Open <https://api.slack.com/apps> and click **Create New App**.
2. Choose **From a manifest**, pick your workspace, and paste the manifest
   below (YAML tab). Rename the app if you like — the name is what you will
   @mention.
3. Click **Create**.

```yaml
display_information:
  name: Wirebot
  description: Codex in your Slack
  background_color: "#1a1d21"
features:
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: Wirebot
    always_online: true
  slash_commands:
    - command: /wirebot
      description: Control Wirebot (new, stop, status, help…)
      usage_hint: "new | back | stop | compact | schedules | status | help"
      should_escape: false
oauth_config:
  scopes:
    bot:
      - chat:write
      - im:history
      - channels:history
      - groups:history
      - mpim:history
      - files:read
      - files:write
      - users:read
      - commands
settings:
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

## 2. Collect the two tokens

- **App-level token** (`xapp-…`): in the app's **Basic Information** page,
  scroll to **App-Level Tokens**, click **Generate Token and Scopes**, name it
  (for example `wirebot-socket`), add the `connections:write` scope, and
  generate. Copy the `xapp-…` value — this is `SLACK_APP_TOKEN`.
- **Bot token** (`xoxb-…`): open **Install App** (or **OAuth & Permissions**),
  click **Install to Workspace**, and approve. Copy the **Bot User OAuth
  Token** — this is `SLACK_BOT_TOKEN`.

## 3. Decide who is allowed

Wirebot answers only authorized users. Two modes:

- **Allowlist**: comma-separated member IDs. In Slack, open a profile →
  **⋯ (More)** → **Copy member ID**; it looks like `U0123ABCDEF`.
- **Whole workspace**: `SLACK_ALLOWED_USER_IDS=*` authorizes every regular
  member of the workspace the app is installed in. Bots, deactivated
  accounts, single/multi-channel guests, and Slack Connect participants from
  other workspaces are still rejected (membership is verified through
  `users.info` and cached for ten minutes, so deactivating someone in Slack
  locks them out without a restart).

Everyone shares one Wirebot: the same Codex account, the same workspace
directory on the host, and the same conversation state per channel/thread.
Open it to the whole workspace only if that is acceptable.

Optionally, `SLACK_ADMIN_USER_IDS` (comma-separated member IDs) restricts
instance-wide commands — `/wirebot config`, `login`, `logout`, `reload`, and
`restart` — to the listed users. Unset, every authorized user may
run them. `/wirebot config` opens interactive Codex settings built from Slack
buttons (model, reasoning effort, speed tier, approvals, sandbox, web
search) in the bot DM — the Slack counterpart of the Telegram Mini App.

## 4. Configure Wirebot

Add the three variables to the `.env` used by the Docker deployment or source checkout:

```dotenv
SLACK_BOT_TOKEN=xoxb-…
SLACK_APP_TOKEN=xapp-…
SLACK_ALLOWED_USER_IDS=U0123ABCDEF,U0456GHIJKL
```

All three must be set together; leaving them all unset keeps the connector
disabled. Telegram is optional when Slack is configured — with only the Slack
variables set, Wirebot runs Slack-only (the Telegram bot and the settings Mini
App stay off). Restart Wirebot and check the log for
`Slack bot connected through Socket Mode`.

## 5. Talk to it

- **Direct message**: open the app under **Apps** in the Slack sidebar and
  send a message. If Slack says the app cannot receive messages, enable the
  Messages Tab: app settings → **App Home** → check *Allow users to send Slash
  commands and messages from the messages tab* (the manifest above enables it,
  but workspaces occasionally need a re-toggle), then reload Slack.
- **Channel**: invite the bot (`/invite @Wirebot`), then mention it:
  `@Wirebot what does this repo do?`. The reply opens a thread; address it
  there with a mention each time (`@Wirebot and now check the tests`) — the
  thread's Codex conversation continues across mentions.
- **Commands**: `/wirebot help` anywhere, or prefix a command in a mention:
  `@Wirebot /new`. In the bot DM, plain `/new` will not reach Wirebot — Slack
  intercepts everything that starts with `/` — so use `/wirebot new`.
  Conversation-scoped commands (`new`, `back`, `stop`, `compact`, `schedules`,
  `continue`) only work as `/wirebot …` in the bot DM; in a channel each thread
  is its own conversation, so run them inside the thread as a mention
  (`@Wirebot /stop`).
- **Sign-in**: if Codex is not signed in yet, `/wirebot login` in the bot DM
  returns the ChatGPT device-code link, exactly like `/login` on Telegram.

## Notes and limits

- **Authorization**: messages, commands, and button clicks from users outside
  `SLACK_ALLOWED_USER_IDS` are ignored (and logged). Scheduled runs re-check
  the owner against the allowlist before every unattended execution.
- **Thread context after a restart**: the "already read this thread" memory
  is in-process, so the first mention after a Wirebot restart re-reads the
  thread history. The Codex conversation itself is persisted and continues.
- **Attachments**: inbound files are downloaded through Slack's private file
  URLs with the bot token (never sent to third-party hosts); generated files
  are uploaded back with `files.uploadV2`. Slack voice clips are transcribed
  the same way Telegram voice messages are.
- **Formatting**: Codex's Markdown is converted to Slack mrkdwn (headings
  become bold lines, `**bold**` becomes `*bold*`, links become
  `<url|label>`); code blocks pass through untouched.
- **Rate limits**: live progress is streamed by editing a single message at
  most every 1.5 seconds, which stays inside Slack's `chat.update` budget.
