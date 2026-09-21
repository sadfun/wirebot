# Send a message

`POST /api/messages` with JSON `{"message":"Check the requested work."}`
sends text to the conversation associated with the authenticated session.
It uses the same queue, active Codex thread, replies and approval prompts as a
chat message. Replies appear in the original messenger.

Use existing Wirebot authentication: the web session cookie, Telegram Mini App
authentication, or `Authorization: Bearer SESSION_TOKEN` with an existing web
session token. Sessions retain their normal expiration and restart/logout
revocation. Cookie requests retain the existing browser-origin checks. No new
API keys, trigger IDs, routing configuration, or thread bindings are needed.

The response is `202 {"accepted":true}`. Messages enter the normal in-memory
processing path; acceptance is not a guarantee of completion across a restart.
The caller owns integration-specific webhook handling, persistence and retries.
The request cannot select another user's conversation or delivery destination.
