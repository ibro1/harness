/**
 * Toolbar popup: connection state, the bridge it points at, and a manual
 * reconnect for when the operator does not want to wait out the backoff.
 *
 * It renders from the status record in chrome.storage.local rather than asking
 * the service worker, so it is correct even when the worker is suspended.
 */

'use strict';

const STATUS_KEY = 'connectionStatus';

const dot = document.getElementById('dot');
const stateEl = document.getElementById('state');
const urlEl = document.getElementById('url');
const detailEl = document.getElementById('detail');
const reconnectButton = document.getElementById('reconnect');
const settingsButton = document.getElementById('settings');

const LABELS = {
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Disconnected',
  unconfigured: 'Not configured',
};

/** @param {number} at epoch ms @returns {string} e.g. "in 8s". */
function relative(at) {
  const seconds = Math.max(Math.round((at - Date.now()) / 1000), 0);
  return seconds === 0 ? 'shortly' : `in ${String(seconds)}s`;
}

/** @param {object | undefined} status */
function render(status) {
  const state = status && typeof status.state === 'string' ? status.state : 'unconfigured';
  dot.className = `dot ${state === 'unconfigured' ? '' : state}`;
  stateEl.textContent = LABELS[state] ?? state;
  urlEl.textContent = status && status.bridgeUrl ? status.bridgeUrl : '';

  if (state === 'unconfigured') {
    detailEl.textContent = 'Set the bridge URL and token in Settings.';
  } else if (state === 'connected') {
    detailEl.textContent = 'The harness can drive this browser.';
  } else if (state === 'disconnected') {
    const parts = [];
    if (status.error) parts.push(status.error);
    if (status.nextAttemptAt) parts.push(`Retrying ${relative(status.nextAttemptAt)}.`);
    detailEl.textContent = parts.join(' ');
  } else {
    detailEl.textContent = '';
  }

  reconnectButton.disabled = state === 'unconfigured';
}

chrome.storage.local.get(STATUS_KEY)
  .then((stored) => render(stored[STATUS_KEY]))
  .catch(() => { detailEl.textContent = 'Could not read the extension status.'; });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(STATUS_KEY in changes)) return;
  render(changes[STATUS_KEY].newValue);
});

reconnectButton.addEventListener('click', () => {
  reconnectButton.disabled = true;
  detailEl.textContent = 'Reconnecting…';
  // The reply only says the attempt started; the status record reports how it
  // ended, and the storage listener above will render that.
  chrome.runtime.sendMessage({ type: 'bridge:reconnect' })
    .catch(() => { detailEl.textContent = 'The extension did not respond; reload it from chrome://extensions.'; })
    .finally(() => { reconnectButton.disabled = false; });
});

settingsButton.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
