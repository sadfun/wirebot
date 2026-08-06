# Discord connector

Wirebot's Discord connector uses the Discord Gateway through
[`discord.js`](https://github.com/discordjs/discord.js). It is text-only, needs no public HTTP
endpoint, and can run alone or beside Telegram and Slack.

## 1. Create the application and bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications), create an
   application, and open its **Bot** page.
2. Create the bot if the portal has not done so already, reset/copy its token, and keep that token
   secret.
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**. Wirebot requests that
   intent so it can read ordinary direct messages, thread follow-ups, and commands. Discord closes
   the Gateway connection when an app requests a privileged intent that is not enabled.
4. Leave Server Members and Presence intents disabled; Wirebot does not request them.

## 2. Install the bot

In **OAuth2 → URL Generator** (or the current **Installation** page), select the `bot` and
`applications.commands` scopes. Grant these bot permissions:

- View Channels
- Send Messages
- Send Messages in Threads
- Create Public Threads
- Read Message History

Open the generated URL and install the app in the server. Wirebot starts a public thread for a new
mention in a normal text channel. If it cannot create or send in that thread, it explains the
missing permission and does not run the task in the shared parent channel. Existing public,
private, announcement, forum, and media-post threads are already conversation boundaries. The bot
must be added to a private thread before it can read or answer there.

## 3. Copy allowed user IDs

Wirebot authorizes people by Discord user snowflake, never by mutable username or server role.
Enable **Developer Mode** in Discord's advanced settings, right-click each allowed user, and choose
**Copy User ID**.

Add the connector to `.env`:

```dotenv
DISCORD_BOT_TOKEN=replace-me
DISCORD_ALLOWED_USER_IDS=123456789012345678,234567890123456789
```

Every listed user may start Codex turns and answer prompts. Messages and interactions from anyone
else are ignored. To restrict instance-wide commands such as login, logout, reload, restart, and
settings while still letting a broader set use Codex, add:

```dotenv
DISCORD_ADMIN_USER_IDS=123456789012345678
```

When `DISCORD_ADMIN_USER_IDS` is unset, every allowed user is an admin. All Discord connector
variables are stripped from the environments of Codex, npm, cloudflared, and other child
processes.

All allowed Discord users operate the same Wirebot installation: they share its Codex account,
workspace, and instance settings. An allowed user ID is authorized anywhere the bot is installed,
not only in one server, so keep both the allowlist and the bot's server membership intentionally
small.

## 4. Start and use it

Start Wirebot normally:

```sh
docker compose up -d
```

In a direct message, send text to Codex immediately. In a server text channel, mention the bot in
the first message; Wirebot creates a thread named from the request and streams the work there.
Messages in a thread created by Wirebot continue naturally without another mention. In an
existing human-owned thread, mention or reply to the bot when you want it to act. On its first
invocation there, Wirebot includes a bounded amount of earlier text as context.

Wirebot owns one global application command with subcommands:

```text
/wirebot start
/wirebot new
/wirebot back
/wirebot stop
/wirebot compact
/wirebot schedules
/wirebot status
/wirebot login
/wirebot logout
/wirebot config
/wirebot reload
/wirebot restart
/wirebot help
```

Conversation commands in a server must run inside a Discord thread because a root channel is not
a stable task boundary. You can also write `!new` or `/new` as a normal direct message, or mention
the bot with that text in a server. `/wirebot config` opens a compact settings picker in a direct
message; the larger web Mini App remains Telegram-authenticated.

Approvals and user-input prompts arrive as buttons. Only the user who received a prompt can answer
it, and controls expire after five minutes or disappear when the requesting turn ends. Scheduled
runs publish back into the originating DM or thread; **Continue this run** switches to the run's
Codex task without changing its delivery destination.

## Text-only and safety behavior

- Incoming attachments, stickers, and polls are never downloaded. With accompanying text, Wirebot
  tells Codex what Discord omitted; media-only messages get a short prompt to paste or describe the
  relevant content. Forwarded text is preserved with a visible context marker; forwarded media
  follows the same omission policy.
- Generated images and linked workspace files are never uploaded to Discord. Wirebot names each
  omitted output file in text, and connector context tells Codex not to promise downloads.
- Replies are split at Discord's 2,000-character content limit. Markdown remains native Discord
  Markdown.
- Every message create and edit uses an empty allowed-mentions policy, disables reply pings, and
  suppresses link embeds. Model or user text therefore cannot ping users, roles, `@everyone`, or
  `@here` through the bot.
- User IDs remain strings end to end; converting Discord snowflakes to JavaScript numbers loses
  precision.

## Troubleshooting

- A Gateway close with code `4014` almost always means **Message Content Intent** is disabled or,
  for a verified large app, not approved.
- If Wirebot can read a channel but cannot answer, re-check **Send Messages**, **Send Messages in
  Threads**, and **Read Message History** on the channel and its category.
- If the first mention gets a thread-permission warning, grant **Create Public Threads** and **Send
  Messages in Threads**. Wirebot will not fall back to a shared root-channel conversation.
- Global application-command updates can take time to appear in every client. Direct messages and
  mention-based `!command` messages continue to work while Discord propagates them.
- Forum and media parents cannot receive messages directly; mention Wirebot inside a post, which
  Discord represents as a thread channel.
