# Combo routing scorecard

The optional `ROUTER_SCORECARD_ENABLED=true` setting enables metadata-only
PostHog capture when the server has `POSTHOG_PROJECT_TOKEN`. The only accepted
host is `https://us.i.posthog.com`; capture is disabled by default and does not
change routing. Requests are sent best-effort and may be lost. No request or
response bodies, error text, account identifiers, tokens, or actor identities
are included. Model names and custom aliases are never exported; events use
`model=not_recorded` because aliases can contain personal information.

`router_combo_attempt` records `request_id` (random UUID for a combo routing
invocation), one-based `attempt`, `model=not_recorded`, `outcome`
(`started`, `selected`, `empty`, or `error`), `fallback_used`, and, when known,
HTTP status and attempt duration. A started event is recorded for each candidate
actually called; a second candidate is a fallback attempt. Smart-router initial
selection is not counted as a fallback. `router_combo_outcome` records the same
request ID, attempt count, fallback-used flag, route duration, and `outcome`.

A selected HTTP response records `outcome=unknown`: a 2xx, content peek, or
selected candidate does not prove the stream or the agent task completed. Route
exhaustion or a non-fallback rejection records `outcome=error`, which refers only
to the routing invocation. These events do not identify stream completion,
cancellation or client delivery, and they do not cover account retries, fusion
routing or single-model calls that do not enter a combo. Missing events remain
unknown. Group by request ID and attempt to avoid counting started and terminal
attempt events as separate attempts. No task ID is inferred from the client.

`cost_status=unknown` is intentional. Router usage records calculate estimated
cost from tokens and configured prices; missing prices and usage can become zero,
so they do not establish provider-billed cost or complete cost per task. Do not
interpret a selected model or a fallback attempt as a successful task.
