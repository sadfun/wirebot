# Trigger an existing conversation

Wirebot exposes an optional authenticated primitive for external applications
to continue a saved conversation and deliver its result through the original
messaging connector. Integration-specific event parsing, webhook verification,
queues, deduplication and retry policy belong to the calling application.

Create `conversation-triggers.json` in `WIREBOT_DATA_DIR`, readable only by the
service user (0600). Each token authorizes one fixed conversation/thread and
delivery destination. Copy these references from existing Wirebot state;
request bodies cannot override them. Configuration is loaded on startup.

```json
[
  {
    "id": "my-conversation",
    "token": "REPLACE_WITH_A_RANDOM_TOKEN_OF_AT_LEAST_32_CHARACTERS",
    "conversationKey": "EXISTING_CONVERSATION_KEY",
    "threadId": "EXISTING_CODEX_THREAD_ID",
    "owner": {"provider": "telegram", "resource": "user", "id": "EXISTING_USER_ID"},
    "deliveryTarget": {"provider": "telegram", "resource": "destination", "id": "EXISTING_DESTINATION"}
  }
]
```

Send `POST /api/triggers/my-conversation`, an `Authorization: Bearer TOKEN`
header and JSON `{"prompt":"Check whether the requested work is ready."}`.
Use HTTPS or a trusted local connection. Protect the token like a credential
that can request agent actions within this conversation.

The API rechecks the configured owner's authorization and acquires the existing
background conversation lane. Busy conversations return 409 and `Retry-After:
30`; no work is queued. Once the turn and optional message delivery complete,
200 returns `threadId`, `turnId` and `notified`. The agent can suppress messages
when there is nothing worth delivering. Execution uses unattended-turn rules;
interactive decisions must be presented in a delivered message and answered in
the original conversation.

The request can remain open for the duration of the turn. Prefer a local caller
or configure your proxy/client timeout accordingly. A connection timeout does
not prove the turn failed or cancel it. The caller must reconcile work before
retrying; Wirebot does not provide durable jobs or exactly-once execution here.
Tokens, user/thread routing, and prompt content are not returned in errors.
