import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
// Lifecycle tests ported from quso-landing scripts/support.test.mjs (same module, see support-widget.js).
const { openSupport, wireSupportLinks, SUPPORT_MAILTO } = createRequire(import.meta.url)('../support-widget.js');

// Fake window + fake clock + fake widget that mimics posthog-js: show() is async, persists widgetState,
// and emits $conversations_widget_loaded / _state_changed through ph.on("eventCaptured").
function make({ storage = {}, blocked = false, conv = {} } = {}) {
  const captured = [];
  const cbs = [];
  const timers = [];
  let now = 0;
  const calls = [];
  const w = {
    captured, calls, storage, listeners: [],
    localStorage: blocked
      ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }
      : { getItem: (k) => storage[k] ?? null, setItem: (k, v) => { storage[k] = v; } },
    document: { addEventListener: (_e, fn) => w.listeners.push(fn) },
    setTimeout(fn, ms) { timers.push([now + ms, fn]); },
    location: { href: '' },
    emit(event, properties) { cbs.forEach((cb) => cb({ event, properties })); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a[0] - b[0]);
        if (!timers.length || timers[0][0] > end) break;
        const [t, fn] = timers.shift();
        now = t; fn();
      }
      now = end;
    },
  };
  let visible = false;
  const ph = {
    config: { token: 'tok' },
    capture: (e, p) => captured.push([e, p]),
    on: (_n, cb) => { cbs.push(cb); return () => cbs.splice(cbs.indexOf(cb), 1); },
    conversations: {
      isAvailable: () => true,
      isVisible: () => visible,
      hide: () => { calls.push('hide'); visible = false; },
      show: () => { calls.push('show'); w.onShow && w.onShow(); },
      ...conv,
    },
  };
  w.ph = ph; w.posthog = ph;
  w.setVisible = (v) => { visible = v; };
  return w;
}
const st = (w) => JSON.parse(w.storage.ph_conv_tok || '{}').widgetState;
const channels = (w) => w.captured.filter(([e]) => e === 'support_opened').map(([, p]) => p.channel);

test('normal open: primes storage, shows, succeeds on the state-changed event, no mailto', () => {
  const w = make();
  w.onShow = () => setTimeout_(() => { w.setVisible(true); w.emit('$conversations_widget_loaded', { initialState: 'open' }); });
  const setTimeout_ = (f) => w.setTimeout(f, 200);
  assert.equal(openSupport(w, 'landing_footer'), 'widget');
  assert.equal(st(w), 'open');
  w.advance(5000);
  assert.deepEqual(w.calls, ['show']);
  assert.equal(w.location.href, '');
  assert.deepEqual(channels(w), ['widget']);
});

test('already-open panel: no hide, no show, no mailto', () => {
  const w = make({ storage: { ph_conv_tok: JSON.stringify({ widgetState: 'open' }) } });
  w.setVisible(true);
  assert.equal(openSupport(w, 'pricing_faq'), 'widget');
  w.advance(5000);
  assert.deepEqual(w.calls, []);
  assert.equal(w.location.href, '');
  assert.deepEqual(channels(w), ['widget']);
});

test('mounted but closed launcher: hide then show to apply the open state', () => {
  const w = make({ storage: { ph_conv_tok: JSON.stringify({ widgetState: 'closed' }) } });
  w.setVisible(true);
  w.onShow = () => w.emit('$conversations_widget_state_changed', { state: 'open' });
  openSupport(w, 'x');
  assert.deepEqual(w.calls, ['hide', 'show']);
  assert.equal(w.location.href, '');
});

test('init already pending: loaded arrives closed, we reopen once, then succeed', () => {
  const w = make();
  let n = 0;
  w.onShow = () => { n += 1; w.setTimeout(() => w.emit('$conversations_widget_loaded', { initialState: n === 1 ? 'closed' : 'open' }), 100); };
  openSupport(w, 'x');
  w.advance(1000);
  assert.equal(n, 2);
  assert.equal(w.location.href, '');
  assert.deepEqual(channels(w), ['widget']);
});

test('SDK not loaded yet: click is queued (no dead click) and opens when it arrives', () => {
  const w = make();
  const real = w.posthog;
  w.posthog = undefined;
  w.setTimeout(() => { w.posthog = real; }, 1000);
  w.onShow = () => w.emit('$conversations_widget_state_changed', { state: 'open' });
  assert.equal(openSupport(w, 'x'), 'widget');
  w.advance(1500);
  assert.deepEqual(w.calls, ['show']);
  assert.equal(w.location.href, '');
});

test('never renders within 3s: mailto once, widget forced closed so it cannot pop up later', () => {
  const w = make();
  openSupport(w, 'landing_footer');
  w.advance(2800);
  assert.equal(w.location.href, '');
  w.advance(400);
  assert.equal(w.location.href, SUPPORT_MAILTO);
  assert.equal(st(w), 'closed');
  assert.deepEqual(channels(w), ['email']);
  assert.ok(w.captured.some(([e]) => e === 'support_widget_failed'));
  w.setVisible(true);
  w.emit('$conversations_widget_loaded', { initialState: 'closed' }); // late render: unmounted again
  assert.ok(w.calls.includes('hide') && w.calls.filter((c) => c === 'hide').length >= 1);
  assert.deepEqual(channels(w), ['email']);
});

test('repeated clicks while opening: one attempt only', () => {
  const w = make();
  openSupport(w, 'a'); openSupport(w, 'b'); openSupport(w, 'c');
  w.advance(200);
  assert.deepEqual(w.calls, ['show']);
});

test('blocked storage or blocked SDK: mailto immediately, analytics failures do not block', () => {
  const s = make({ blocked: true });
  openSupport(s, 'x'); s.advance(200);
  assert.equal(s.location.href, SUPPORT_MAILTO);
  const b = make(); b.posthogFailed = true;
  assert.equal(openSupport(b, 'x'), 'email');
  const t = make(); t.ph.capture = () => { throw new Error('boom'); };
  openSupport(t, 'x'); t.advance(4000);
  assert.equal(t.location.href, SUPPORT_MAILTO);
});

test('click handler: preventDefault only when the widget owns the click', () => {
  const w = make();
  wireSupportLinks(w);
  const el = { getAttribute: () => 'landing_footer' };
  const ev = (over = {}) => ({ target: { closest: () => el }, button: 0, prevented: false, preventDefault() { this.prevented = true; }, ...over });
  const a = ev(); w.listeners[0](a); assert.equal(a.prevented, true);
  const b = ev({ metaKey: true }); w.listeners[0](b); assert.equal(b.prevented, false);
  const c = ev({ target: { closest: () => null } }); w.listeners[0](c); assert.equal(c.prevented, false);
  const f = make(); f.posthogFailed = true; wireSupportLinks(f);
  const d = ev(); f.listeners[0](d); assert.equal(d.prevented, false);
});

test('published address is help@', () => assert.equal(SUPPORT_MAILTO, 'mailto:help@quso.ai'));

test('opted-out capture (no widget events to confirm an open): mailto at once, widget untouched', () => {
  const w = make();
  w.ph.has_opted_out_capturing = () => true;
  w.onShow = () => w.setVisible(true);
  assert.equal(openSupport(w, 'x'), 'widget');
  assert.equal(w.location.href, SUPPORT_MAILTO);
  assert.deepEqual(w.calls, []);
  assert.equal(st(w), undefined);
  w.advance(4000);
  assert.deepEqual(channels(w), ['email']);
});

test('retry after a timeout: the stale late-render cleanup does not hide the new panel', () => {
  const w = make();
  openSupport(w, 'x'); w.advance(3200);
  assert.equal(w.location.href, SUPPORT_MAILTO);
  w.location.href = '';
  w.onShow = () => w.setTimeout(() => { w.setVisible(true); w.emit('$conversations_widget_loaded', { initialState: 'open' }); }, 200);
  openSupport(w, 'x'); w.advance(1000);
  assert.ok(!w.calls.includes('hide'));
  assert.equal(w.location.href, '');
  assert.deepEqual(channels(w), ['email', 'widget']);
});

test('late-render cleanup expires, so it never hides a panel opened much later', () => {
  const w = make();
  openSupport(w, 'x'); w.advance(3200 + 30000);
  w.setVisible(true);
  w.emit('$conversations_widget_loaded', { initialState: 'open' });
  assert.ok(!w.calls.includes('hide'));
});

test('SDK fails while the click is queued: mailto immediately', () => {
  const w = make(); w.posthog = undefined;
  openSupport(w, 'x');
  w.setTimeout(() => { w.posthogFailed = true; }, 300);
  w.advance(500);
  assert.equal(w.location.href, SUPPORT_MAILTO);
});

// Docs adapter (Mintlify has no posthogFailed boot flag; links are matched by their mailto href).
test('docs: PostHog never appears: click is queued, then the mailto at 3s with reason unavailable', () => {
  const w = make(); w.posthog = undefined;
  assert.equal(openSupport(w, 'help_center_link'), 'widget');
  w.advance(2800);
  assert.equal(w.location.href, '');
  w.advance(400);
  assert.equal(w.location.href, SUPPORT_MAILTO);
});

test('docs: only mailto:help@quso.ai links are wired, reported as help_center_link', () => {
  const w = make();
  wireSupportLinks(w);
  let selector = null;
  const ev = { target: { closest: (s) => { selector = s; return {}; } }, button: 0, preventDefault() { this.prevented = true; } };
  w.onShow = () => w.emit('$conversations_widget_state_changed', { state: 'open' });
  w.listeners[0](ev);
  assert.equal(selector, 'a[href^="mailto:help@quso.ai"]');
  assert.equal(ev.prevented, true);
  assert.deepEqual(w.captured.find(([e]) => e === 'support_opened')[1], { entry_point: 'help_center_link', channel: 'widget' });
});
