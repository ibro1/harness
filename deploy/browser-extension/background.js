/**
 * Harness Browser Bridge - service worker.
 *
 * The harness cannot reach this browser (NAT, a laptop, a corporate network),
 * so the browser dials out and holds one WebSocket open. Every frame the
 * harness sends is a command with a correlation id; this worker executes it and
 * writes back exactly one reply carrying that same id.
 *
 * Wire protocol (fixed, mirrored from packages/host/browser-bridge):
 *   in   { "id": "<uuid>", "type": "<command>", "payload": { ... } }
 *   out  { "id": "<uuid>", "result": <any> }   on success
 *   out  { "id": "<uuid>", "error": "<text>" } on failure
 *
 * 'navigate' and 'wait' are executed here, because they are about the tab and
 * the clock rather than the document. Everything else is relayed to content.js
 * in the active tab as { command, payload } and answered with { result } or
 * { error }.
 */

'use strict';

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** chrome.storage.local keys. Config is written by the options page. */
const CONFIG_KEYS = ['bridgeUrl', 'token'];
/** Where the popup reads the live connection state from. */
const STATUS_KEY = 'connectionStatus';

/** First reconnect delay, and the ceiling the exponential backoff climbs to. */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/**
 * The harness abandons a command after 30s. We answer with our own error a
 * little before that, so the operator sees "the page never answered" instead of
 * the harness's vaguer timeout, and so no id is ever left unanswered.
 */
const COMMAND_TIMEOUT_MS = 25_000;
/** How long 'navigate' waits for the tab to reach status 'complete'. */
const NAVIGATE_TIMEOUT_MS = 20_000;
/** Upper bound on 'wait', kept under COMMAND_TIMEOUT_MS. */
const MAX_WAIT_MS = 20_000;

/**
 * An MV3 service worker is torn down after ~30s idle. Two things keep this one
 * alive, because either alone has a gap:
 *  - a tiny frame on the socket every 20s; WebSocket traffic resets the idle
 *    timer, and the harness ignores any frame whose id matches no pending call,
 *    so this costs the protocol nothing.
 *  - an alarm, which survives a teardown and wakes the worker back up. Chrome
 *    clamps periods below 30s (and below 60s on older builds), so the alarm is
 *    the recovery path, not the keepalive.
 */
const KEEPALIVE_ALARM = 'bridge-keepalive';
const KEEPALIVE_PERIOD_MINUTES = 0.5;
const PING_INTERVAL_MS = 20_000;

/* -------------------------------------------------------------------------- */
/* Connection state                                                            */
/* -------------------------------------------------------------------------- */

/** @type {WebSocket | null} */
let socket = null;
/** Consecutive failed attempts; drives the backoff, reset on a clean open. */
let failures = 0;
/** Epoch ms before which we must not dial again. */
let nextAttemptAt = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let reconnectTimer = null;
/** @type {ReturnType<typeof setInterval> | null} */
let pingTimer = null;
/** True while reconnectNow() is between closing one socket and opening the next. */
let reconnecting = false;
/**
 * Ids currently executing. The harness must get exactly one reply per id, so a
 * repeated id is dropped rather than run twice - the first run still answers it.
 */
const inFlight = new Set();

/* -------------------------------------------------------------------------- */
/* Status, for the popup and options page                                      */
/* -------------------------------------------------------------------------- */

/**
 * Publish the connection state. The popup and options page render from
 * storage and subscribe to chrome.storage.onChanged, so they stay correct even
 * while the worker is asleep.
 * @param {'connected'|'connecting'|'disconnected'|'unconfigured'} state
 * @param {{ bridgeUrl?: string, error?: string }} [detail]
 */
function publishStatus(state, detail = {}) {
  const status = {
    state,
    bridgeUrl: detail.bridgeUrl ?? '',
    error: detail.error ?? '',
    failures,
    nextAttemptAt: state === 'connected' ? 0 : nextAttemptAt,
    updatedAt: Date.now(),
  };
  // Fire and forget: a failed status write must never break the connection.
  chrome.storage.local.set({ [STATUS_KEY]: status }).catch(() => {});
}

/** @param {unknown} err @returns {string} a message safe to put on the wire. */
function describe(err) {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return 'the extension failed with an unspecified error';
}

/* -------------------------------------------------------------------------- */
/* Connecting                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build the upgrade URL. The token rides the query string because a browser
 * cannot set headers on a WebSocket handshake.
 * @param {string} bridgeUrl @param {string} token @returns {string}
 */
function buildUrl(bridgeUrl, token) {
  const url = new URL(bridgeUrl);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`the bridge URL must start with wss:// or ws://, not ${url.protocol}//`);
  }
  // set(), not an appended '?token=': the operator may have pasted a URL that
  // already carries a query, and a second '?' would make the token unreadable.
  url.searchParams.set('token', token);
  return url.toString();
}

/** Clear the pending reconnect timer, if any. */
function cancelReconnect() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

/**
 * Open the socket unless one is already up or a backoff is still running.
 * @param {{ immediate?: boolean }} [options] immediate skips the backoff wait,
 *   for an operator-driven "Reconnect" or a settings change.
 */
async function connect(options = {}) {
  const immediate = options.immediate === true;

  if (socket !== null && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const config = await chrome.storage.local.get(CONFIG_KEYS);
  const bridgeUrl = typeof config.bridgeUrl === 'string' ? config.bridgeUrl.trim() : '';
  const token = typeof config.token === 'string' ? config.token : '';
  if (bridgeUrl === '' || token === '') {
    // Nothing to dial. Stay quiet rather than burning a retry loop; the options
    // page will trigger a connect the moment both fields are saved.
    failures = 0;
    nextAttemptAt = 0;
    cancelReconnect();
    publishStatus('unconfigured', { bridgeUrl });
    return;
  }

  if (immediate) {
    failures = 0;
    nextAttemptAt = 0;
    cancelReconnect();
  } else if (Date.now() < nextAttemptAt) {
    // Still inside the backoff window. Re-arm the timer, since a worker teardown
    // may have discarded the one that was running.
    scheduleReconnect(nextAttemptAt - Date.now(), bridgeUrl);
    return;
  }

  let target;
  try {
    target = buildUrl(bridgeUrl, token);
  } catch (err) {
    // A malformed URL will not fix itself; stop instead of retrying forever.
    failures = 0;
    nextAttemptAt = 0;
    cancelReconnect();
    publishStatus('disconnected', { bridgeUrl, error: describe(err) });
    return;
  }

  cancelReconnect();
  publishStatus('connecting', { bridgeUrl });

  let ws;
  try {
    ws = new WebSocket(target);
  } catch (err) {
    handleClose(bridgeUrl, describe(err));
    return;
  }
  socket = ws;

  ws.addEventListener('open', () => {
    if (socket !== ws) return;
    failures = 0;
    nextAttemptAt = 0;
    startPing();
    publishStatus('connected', { bridgeUrl });
  });

  ws.addEventListener('message', (event) => {
    if (socket !== ws) return;
    receive(typeof event.data === 'string' ? event.data : '');
  });

  ws.addEventListener('close', (event) => {
    if (socket !== ws) return;
    socket = null;
    // The server destroys the socket without a response when the token is
    // wrong, so a close with no reason right after connecting usually means a
    // bad token rather than a network fault. Say so, without asserting it.
    const reason = event.reason
      || (event.code === 1006 ? 'the connection dropped; if this repeats, check the bridge URL and token' : `closed with code ${String(event.code)}`);
    handleClose(bridgeUrl, reason);
  });

  ws.addEventListener('error', () => {
    // 'error' carries no detail in a browser and is always followed by 'close',
    // which owns the reconnect. Nothing to do here but avoid an unhandled event.
  });
}

/**
 * Tear down after a lost or refused connection and arm the next attempt.
 * @param {string} bridgeUrl @param {string} error
 */
function handleClose(bridgeUrl, error) {
  socket = null;
  stopPing();
  failAllInFlight();
  failures += 1;
  // Exponential backoff, capped, with jitter: a harness restart disconnects
  // every extension at once, and unjittered clients would retry in lockstep.
  const capped = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
  const delay = Math.round(capped * (0.5 + Math.random() * 0.5));
  nextAttemptAt = Date.now() + delay;
  publishStatus('disconnected', { bridgeUrl, error });
  scheduleReconnect(delay, bridgeUrl);
}

/**
 * @param {number} delay ms @param {string} bridgeUrl for the status record.
 */
function scheduleReconnect(delay, bridgeUrl) {
  cancelReconnect();
  // This timer dies with the worker; the keepalive alarm is what recovers from
  // that, by calling connect() again once Chrome wakes us.
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch((err) => publishStatus('disconnected', { bridgeUrl, error: describe(err) }));
  }, Math.max(delay, 0));
}

/**
 * Drop the current socket and dial again now.
 *
 * Guarded because a save on the options page triggers two paths at once - the
 * storage listener and the explicit message - and an unguarded second call
 * would abandon the socket the first one had just opened.
 */
async function reconnectNow() {
  if (reconnecting) return;
  reconnecting = true;
  try {
    const existing = socket;
    socket = null;
    stopPing();
    if (existing !== null) {
      try { existing.close(1000, 'reconnect requested'); } catch { /* already closing */ }
    }
    await connect({ immediate: true });
  } finally {
    reconnecting = false;
  }
}

/** Start the keepalive frames. Idempotent. */
function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    // No id: the harness matches replies by id and ignores frames that match
    // nothing, so this is inert on the server and only exists to keep the MV3
    // worker's idle timer from expiring.
    try { socket.send(JSON.stringify({ type: 'ping' })); } catch { /* close is coming */ }
  }, PING_INTERVAL_MS);
}

/** Stop the keepalive frames. Idempotent. */
function stopPing() {
  if (pingTimer !== null) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

/* -------------------------------------------------------------------------- */
/* Frame handling                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Send one reply. Never called twice for the same id.
 * @param {object} frame
 */
function send(frame) {
  if (socket === null || socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(frame));
  } catch {
    // The socket died between the check and the send. The harness will time the
    // command out, and 'close' has already scheduled the reconnect.
  }
}

/** @param {string} raw one text frame from the harness. */
function receive(raw) {
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    // Unparseable, so there is no id to answer. Dropping it is the only option.
    return;
  }
  if (frame === null || typeof frame !== 'object') return;
  const id = typeof frame.id === 'string' ? frame.id : '';
  if (id === '') return;

  if (typeof frame.type !== 'string' || frame.type === '') {
    send({ id, error: 'the command frame had no type' });
    return;
  }
  if (inFlight.has(id)) {
    // A duplicate id would produce a second reply for a command the harness has
    // already correlated. The in-flight run answers it.
    return;
  }
  inFlight.add(id);

  const payload = frame.payload !== null && typeof frame.payload === 'object' ? frame.payload : {};
  withTimeout(execute(frame.type, payload), COMMAND_TIMEOUT_MS, frame.type)
    .then(
      (result) => { send({ id, result: result === undefined ? null : result }); },
      (err) => { send({ id, error: describe(err) }); },
    )
    .finally(() => { inFlight.delete(id); });
}

/** Forget in-flight commands after a disconnect; their replies can go nowhere. */
function failAllInFlight() {
  inFlight.clear();
}

/**
 * @param {Promise<unknown>} promise @param {number} ms @param {string} label
 * @returns {Promise<unknown>} rejecting if the work outlives ms.
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} did not finish within ${String(ms)}ms`));
    }, ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} type @param {Record<string, unknown>} payload
 * @returns {Promise<unknown>} the value to put in the result frame.
 */
async function execute(type, payload) {
  switch (type) {
    case 'navigate':
      return navigate(payload);
    case 'wait':
      return wait(payload);
    default:
      // click, type, scroll, snapshot and anything the content script grows
      // later are its business; this worker stays out of the document.
      return relayToActiveTab(type, payload);
  }
}

/** @param {Record<string, unknown>} payload @returns {Promise<string>} */
async function navigate(payload) {
  const raw = typeof payload.url === 'string' ? payload.url.trim() : '';
  if (raw === '') throw new Error('navigate needs a url');

  let target;
  try {
    target = new URL(raw);
  } catch {
    throw new Error(`navigate could not parse the url: ${raw}`);
  }
  // Only the web. javascript:, data: and chrome:// would either run script with
  // the page's authority or land somewhere the content script cannot follow,
  // and the harness has no business steering the browser there.
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`navigate only accepts http and https urls, not ${target.protocol}//`);
  }

  const tab = await getActiveTab();
  // Registered before the update, so a fast load cannot complete in the gap.
  const loaded = waitForLoad(tab.id, NAVIGATE_TIMEOUT_MS);
  // Its listeners are removed by its own timeout if the update below throws.
  loaded.catch(() => {});
  await chrome.tabs.update(tab.id, { url: target.href });
  await loaded;

  const settled = await chrome.tabs.get(tab.id);
  const url = settled.url ?? target.href;
  const title = settled.title ?? '';
  // A sentence, not a record: the reply is read by a model, and tab ids are
  // this extension's bookkeeping rather than anything it can act on.
  return title === '' ? `Navigated to ${url}` : `Navigated to ${url} (${title})`;
}

/** @param {Record<string, unknown>} payload @returns {Promise<string>} */
async function wait(payload) {
  const requested = typeof payload.ms === 'number' && Number.isFinite(payload.ms) ? payload.ms : 1_000;
  // Clamped: a wait longer than the harness's own timeout can only ever fail.
  const ms = Math.min(Math.max(Math.round(requested), 0), MAX_WAIT_MS);
  await new Promise((resolve) => setTimeout(resolve, ms));
  return `Waited ${ms}ms.`;
}

/**
 * @param {number} tabId @param {number} timeoutMs
 * @returns {Promise<void>} resolving when the tab reports status 'complete'.
 */
function waitForLoad(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      fn(arg);
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(resolve, undefined);
    };
    const onRemoved = (id) => {
      if (id === tabId) finish(reject, new Error('the tab was closed while navigating'));
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(`the page did not finish loading within ${String(timeoutMs)}ms`));
    }, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

/**
 * The tab commands act on: the active tab of the focused window.
 * @returns {Promise<chrome.tabs.Tab & { id: number }>}
 */
async function getActiveTab() {
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs.length === 0) {
    // No focused window - the browser may be minimised, or focus may sit on a
    // devtools or app window. Fall back to any active normal tab.
    tabs = await chrome.tabs.query({ active: true, windowType: 'normal' });
  }
  const tab = tabs.find((candidate) => typeof candidate.id === 'number');
  if (tab === undefined || typeof tab.id !== 'number') {
    throw new Error('no active browser tab; open a tab and try again');
  }
  return /** @type {chrome.tabs.Tab & { id: number }} */ (tab);
}

/**
 * Relay one command to content.js in the active tab.
 * @param {string} command @param {Record<string, unknown>} payload
 * @returns {Promise<unknown>}
 */
async function relayToActiveTab(command, payload) {
  const tab = await getActiveTab();
  const url = tab.url ?? '';
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    // chrome://, the Web Store and about:blank forbid content scripts, so this
    // would otherwise surface as an opaque "receiving end does not exist".
    throw new Error(`the active tab (${url || 'unknown url'}) is not a web page the extension can read; switch to an http or https tab`);
  }

  const message = { command, payload };
  try {
    return unwrap(await chrome.tabs.sendMessage(tab.id, message), command);
  } catch (err) {
    if (!isMissingReceiver(err)) throw err;
    // The tab predates this extension's install or reload, so the manifest's
    // content script never ran in it. Inject once and retry; we only get here
    // when nothing is listening, so this cannot double-register a live script.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    return unwrap(await chrome.tabs.sendMessage(tab.id, message), command);
  }
}

/** @param {unknown} err @returns {boolean} true for "no content script there". */
function isMissingReceiver(err) {
  return describe(err).includes('Receiving end does not exist');
}

/**
 * Turn the content script's { result } / { error } into a value or a throw.
 * @param {unknown} response @param {string} command @returns {unknown}
 */
function unwrap(response, command) {
  if (response === null || typeof response !== 'object') {
    throw new Error(`the page did not answer ${command}`);
  }
  if (typeof response.error === 'string' && response.error !== '') {
    throw new Error(response.error);
  }
  if (!('result' in response)) {
    throw new Error(`the page answered ${command} with neither a result nor an error`);
  }
  return response.result === undefined ? null : response.result;
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                      */
/* -------------------------------------------------------------------------- */

/** Every entry point calls this; connect() is a no-op when already up. */
function ensureConnected() {
  connect().catch(() => {
    // connect() publishes its own failures; nothing further to report here.
  });
}

// Listeners are registered at the top level, not inside an init function: a
// woken service worker only replays events for handlers that exist by the end
// of its first turn.
chrome.runtime.onStartup.addListener(ensureConnected);
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MINUTES });
  ensureConnected();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  // The wake-up path: if the worker was torn down mid-backoff, its timer went
  // with it, and this is what dials again.
  ensureConnected();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  // Ignore our own status writes, which would otherwise reconnect in a loop.
  if (!CONFIG_KEYS.some((key) => key in changes)) return;
  reconnectNow().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message === null || typeof message !== 'object') return false;
  if (message.type === 'bridge:reconnect') {
    reconnectNow()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: describe(err) }));
    return true; // keeps the channel open for the async reply
  }
  if (message.type === 'bridge:ensure') {
    ensureConnected();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// Also run on every worker start, which covers a wake for any other reason.
chrome.alarms.get(KEEPALIVE_ALARM).then((alarm) => {
  if (alarm === undefined) {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MINUTES });
  }
}).catch(() => {});
ensureConnected();
