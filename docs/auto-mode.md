# Auto effort and speed

Auto mode reclassifies every foreground user turn from the full active Codex
history and the latest request. Slack channel messages also include the complete
Slack thread; local fallback rules use only the latest message. DMs use the active
Codex thread and start fresh after `new`.

The classifier uses the user's Codex ChatGPT subscription with GPT-6.1 Sol, Low
effort and Fast when advertised by the model catalog. It has a separate ephemeral
thread, empty workspace, no tools or MCP servers, and a 20-second deadline covering
configuration, history and startup as well as inference. Cancellation releases
pending waits and cleans up late thread/turn startup responses. API-key accounts
and classifier failures use local rules without launching an additional billed
API request.

The answering model is unchanged. Supported effort and speed come from its live
catalog entry, including the effective model of a resumed model-specific schedule.
Auto uses `serviceTierForTurn` so its speed choice does not become a saved thread
preference. Manual turns and scheduled runs explicitly restore the effective
model's default effort when the configured effort is unset.
If model metadata cannot be read, Wirebot logs the lookup failure and keeps the
loaded settings so otherwise runnable foreground and scheduled turns can continue.

## Codex 0.162.1 protocol evidence

The compatibility behavior below was checked with the pinned **Codex 0.162.1**
app-server on 2026-10-11, using a fresh temporary Codex home and a loopback Responses
fixture with `requires_openai_auth = false`. Inference was simulated locally;
no vendor API key, subscription inference, external model endpoint or account
entitlement was involved. These observations verify app-server transport and
settings semantics, not live model availability.

Three sequential `turn/start` calls on the same thread produced these provider
request settings:

| Sent model / effort / persistent tier / per-turn tier | Provider model | Provider effort | Provider tier |
| --- | --- | --- | --- |
| `gpt-6-luna` / `max` / `priority` / omitted | `gpt-6-luna` | `max` | `priority` |
| `null` / `null` / `null` / `default` | `gpt-6-luna` | `max` | omitted (Standard) |
| `null` / `medium` / `default` / omitted | `gpt-6-luna` | `medium` | omitted (Standard) |

Thus null model and effort preserve the loaded settings, while explicit effort
restores the requested value. Both the persistent `default` value and the
documented per-turn `default` value were accepted. Auto uses the latter to avoid
changing persistent speed.

All three startup responses had empty `turn.items`. Successful completion
notifications carried the final agent message with `itemsView: "summary"`.
The classifier accepts this normal path and also retains `item/completed` text
for completions without answer items. It does not assume completion items are
always empty.

The pinned upstream implementation provides the corresponding contracts:

- [Turn processing and persistent overrides](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server/src/request_processors/turn_processor.rs): nullable effort maps to an optional override; null does not clear it.
- [Completion notifications](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server/src/bespoke_event_handling.rs): the last agent message becomes a summary item when available; otherwise the item list is empty.

Regression tests cover both completion shapes, cancellation during every startup
stage, late cleanup, default-effort restoration for manual/scheduled turns,
effective-model selection, full history and latest-message fallback routing.
