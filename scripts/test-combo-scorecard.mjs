import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComboScorecard } from '../open-sse/services/comboScorecard.mjs';

const ENV = { ROUTER_SCORECARD_ENABLED: 'true', POSTHOG_PROJECT_TOKEN: 'test', POSTHOG_HOST: 'https://us.i.posthog.com' };
const ID = '4ddaa4bb-839f-4d30-99be-ecfdf17363cc';
test('scorecard uses bounded metadata and never promotes selected 2xx to completion', () => {
  const events = [];
  let time = 100;
  const observer = createComboScorecard({ env: ENV, emit: (event, properties) => events.push({ event, properties }), now: () => ++time, makeId: () => ID });
  observer.start('provider/model-a');
  observer.attempt('provider/model-a', 'error', 503);
  observer.start('provider/model-b');
  observer.attempt('provider/model-b', 'selected', 200);
  observer.finish('unknown', 'provider/model-b');
  assert.deepEqual(events.map(e => e.properties.outcome), ['started', 'error', 'started', 'selected', 'unknown']);
  assert.ok(events.every(e => e.properties.request_id === ID));
  assert.equal(events.at(-1).properties.fallback_used, true);
  assert.equal(events.at(-1).properties.attempt_count, 2);
  assert.equal(events.at(-1).properties.cost_status, 'unknown');
  assert.equal(events.at(-1).properties.model, 'not_recorded');
  assert.ok(!JSON.stringify(events).includes('secret response'));
  assert.equal(createComboScorecard({ env: { ...ENV, POSTHOG_HOST: 'https://other.example' } }), null);
  assert.equal(createComboScorecard({ env: {} }), null);
  assert.equal(createComboScorecard({ env: ENV, makeId: () => 'not-a-uuid' }), null);
  const unsafe = [];
  const safeObserver = createComboScorecard({ env: ENV, emit: (_, p) => unsafe.push(p), makeId: () => ID });
  safeObserver.start('private value with spaces');
  assert.equal(unsafe[0].model, 'not_recorded');
  safeObserver.start('not/allowlisted');
  assert.equal(unsafe[1].model, 'not_recorded');
});

// Exercise the real combo loop with only its provider-specific imports stubbed.
const stubs = {
  './accountFallback.js': 'export const checkFallbackError = () => ({shouldFallback:true,cooldownMs:0}); export const formatRetryAfter = () => "later";',
  '../utils/error.js': 'export const unavailableResponse = status => new Response("unavailable",{status});',
  '../providers/capabilities.js': 'export const getCapabilitiesForModel = () => ({});',
  './model.js': 'export const parseModel = () => ({provider:"p"});',
  '../translator/formats/gemini.js': 'export const extractTextContent = () => "";',
  './emptyFailover.js': 'export const peekStreamForContent = () => { throw Error("unexpected stream read"); }; export const reconstructStream = () => {}; export const isNoRetryFinish = () => false;',
  './systemoneRouter.js': 'export const getStickyComboModel = () => null; export const setStickyComboModel = () => {}; export const clearStickyComboSession = () => {}; export const orderModelsByChoice = models => models;',
};
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/open-sse/services/combo.js') && stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
  return next(specifier, context);
} });
const { handleComboChat } = await import('../open-sse/services/combo.js');

test('real combo fallback preserves returned body while reporting attempts; telemetry failure is ignored', async () => {
  const original = { ...process.env };
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, ENV);
  const events = [];
  globalThis.fetch = (_url, init) => { events.push(JSON.parse(init.body)); return Promise.reject(new Error('capture unavailable')); };
  try {
    const tried = [];
    const response = await handleComboChat({ body: {}, models: ['p/a', 'p/b'], autoSwitch: false, comboStrategy: 'fallback', log: { info() {}, warn() {} },
      handleSingleModel: async (_body, model) => { tried.push(model); return model === 'p/a' ? new Response('{"error":"private"}', { status: 503, headers: { 'content-type': 'application/json' } }) : new Response('{"choices":[{"message":{"content":"private result"}}]}', { status: 200, headers: { 'content-type': 'application/json' } }); } });
    assert.deepEqual(tried, ['p/a', 'p/b']);
    assert.equal((await response.json()).choices[0].message.content, 'private result');
    assert.equal(events.filter(e => e.event === 'router_combo_attempt' && e.properties.outcome === 'started').length, 2);
    assert.equal(events.find(e => e.event === 'router_combo_outcome').properties.outcome, 'unknown');
    assert.ok(!JSON.stringify(events).includes('private'));
  } finally { globalThis.fetch = originalFetch; process.env = original; }
});


test('exhausted candidates report a router error, not a completed task', async () => {
  const oldEnv = { ...process.env };
  const oldFetch = globalThis.fetch;
  Object.assign(process.env, ENV);
  const events = [];
  globalThis.fetch = (_url, init) => { events.push(JSON.parse(init.body)); return Promise.resolve({ ok: true }); };
  try {
    const response = await handleComboChat({ body: {}, models: ['p/a', 'p/b'], autoSwitch: false, comboStrategy: 'fallback', log: { info() {}, warn() {} },
      handleSingleModel: async () => new Response('{"error":"secret"}', { status: 503, headers: { 'content-type': 'application/json' } }) });
    assert.equal(response.status, 503);
    const outcome = events.find(event => event.event === 'router_combo_outcome').properties;
    assert.equal(outcome.outcome, 'error');
    assert.equal(outcome.attempt_count, 2);
    assert.equal(outcome.fallback_used, true);
    assert.ok(!JSON.stringify(events).includes('secret'));
  } finally { globalThis.fetch = oldFetch; process.env = oldEnv; }
});
