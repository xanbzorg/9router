// Optional metadata-only combo observation. Never read or wrap a response body.
// These events describe candidate selection, not completion of the caller's task.
function safeConfig(env) {
  if (env.ROUTER_SCORECARD_ENABLED !== 'true' || !env.POSTHOG_PROJECT_TOKEN) return null;
  try {
    const host = new URL(env.POSTHOG_HOST || 'https://us.i.posthog.com');
    if (host.origin !== 'https://us.i.posthog.com' || host.pathname !== '/' || host.search || host.hash || host.username || host.password) return null;
    return { token: env.POSTHOG_PROJECT_TOKEN, url: new URL('/i/v0/e/', host).href };
  } catch { return null; }
}

function send(config, event, properties) {
  // No caller waits on telemetry; absent fetch, timeout, and rejection all fail open.
  try {
    Promise.resolve(fetch(config.url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: config.token, event, properties }),
      signal: AbortSignal.timeout(1500),
    })).catch(() => {});
  } catch { /* unsupported runtime or invalid capture configuration */ }
}

export function createComboScorecard({ env = globalThis.process?.env ?? {}, emit, now = Date.now, makeId = () => globalThis.crypto.randomUUID() } = {}) {
  const config = safeConfig(env);
  if (!config) return null;
  try {
    const requestId = makeId();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) return null;
    const started = now();
    const publish = emit ?? ((event, properties) => send(config, event, properties));
    const base = { distinct_id: '9router:combo', request_id: requestId, cost_status: 'unknown' };
    const observe = (event, props) => { try { publish(event, { ...base, ...props }); } catch { /* telemetry is optional */ } };
    let attempts = 0;
    let attemptStarted = started;
    // Combo aliases can contain private data; never export their names.
    const safeModel = () => ({ model: 'not_recorded' });
    const duration = (since) => Math.max(0, now() - since);
    return {
      start(model) {
        try {
          attempts += 1;
          attemptStarted = now();
          observe('router_combo_attempt', { attempt: attempts, ...safeModel(model), outcome: 'started', fallback_used: attempts > 1 });
        } catch { /* observer cannot change routing */ }
      },
      attempt(model, outcome, status) {
        try {
          if (!['selected', 'empty', 'error'].includes(outcome)) return;
          observe('router_combo_attempt', { attempt: attempts, ...safeModel(model), outcome, fallback_used: attempts > 1,
            duration_ms: duration(attemptStarted), ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { http_status: status } : {}) });
        } catch { /* observer cannot change routing */ }
      },
      finish(outcome, model) {
        try {
          if (!['unknown', 'error'].includes(outcome)) return;
          observe('router_combo_outcome', { attempt_count: attempts, ...safeModel(model), outcome,
            fallback_used: attempts > 1, duration_ms: duration(started) });
        } catch { /* observer cannot change routing */ }
      },
    };
  } catch { return null; }
}
