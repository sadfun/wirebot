# GitHub wakeups

An operator can bind a GitHub repository to an existing Wirebot conversation.
Authenticated events enqueue a turn on the existing Codex thread; Wirebot waits
for the conversation's background lane, resumes the thread, and publishes the
result through its configured messaging connector. There is no second Codex
CLI process, repository polling loop, or public endpoint accepting arbitrary
prompts or destinations.

Create `github-webhooks.json` in `WIREBOT_DATA_DIR`, readable only by the
Wirebot service user (mode 0600), containing an array of bindings:

```json
[
  {
    "id": "maintenance",
    "secret": "REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS",
    "repository": "owner/repository",
    "events": ["pull_request_review", "issue_comment", "workflow_run"],
    "conversationKey": "EXISTING_PROVIDER_CONVERSATION_KEY",
    "threadId": "EXISTING_CODEX_THREAD_ID",
    "owner": {"provider": "telegram", "resource": "user", "id": "EXISTING_USER_ID"},
    "deliveryTarget": {"provider": "telegram", "resource": "destination", "id": "EXISTING_PROVIDER_DESTINATION"},
    "prompt": "Inspect the current PR and CI state. Act only within existing user authorization."
  }
]
```

Copy references from existing authenticated Wirebot conversation/schedule
records; do not invent identifiers. Configuration is loaded at startup. A
missing file disables the feature. Invalid configuration fails startup.

Configure a GitHub repository webhook at
`https://YOUR_PUBLIC_ORIGIN/api/hooks/github/maintenance`, content type JSON,
with the matching secret, SSL verification enabled, and only the chosen events.
The reverse proxy must preserve the raw request body and signature headers.
GitHub repository administration permission is required to register a hook.

Wirebot verifies HMAC-SHA256 over the raw body, checks repository and event
allowlists, and bounds each request to 1 MiB. Ping requests validate the hook
without starting a turn. Only completed workflow/check events and PR-related
issue comments wake the conversation. Payload comments and titles are not
injected into the prompt: the agent receives minimal event metadata and must
fetch current state from GitHub. A signed event is not user approval.

Accepted work is persisted before HTTP 202. The queue allows at most 100 active
events and retains the most recent 500 completed/failed records for duplicate
detection. Both delivery IDs and signed-body hashes are checked, including
across restarts. Pending/running work resumes after restart; workflows must
reconcile remote mutations before retrying. Events wait while foreground work
owns the conversation. Queue retry timers only service already-received work;
they do not poll GitHub.

Results use `{ "notify": boolean, "message": string }`; only nonempty results
with `notify=true` are delivered. The configured owner is reauthorized before
each run. Failures are recorded in `github-webhook-deliveries.json` and logged.
Failed records are not automatically replayed: investigate before operator
recovery. Delivery is not exactly-once across a crash between provider publish
and recording completion; downstream operations must remain idempotent.

This endpoint cannot subscribe to upstream repositories you do not administer.
Upstream release discovery still needs a separate source of notifications or a
periodic check.
