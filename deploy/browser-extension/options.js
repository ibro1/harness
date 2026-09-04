/**
 * Settings page: bridge URL, token, and a live view of the connection.
 *
 * Saving writes to chrome.storage.local. The service worker watches those keys
 * and reconnects on its own, so this page never opens a socket itself.
 */

'use strict';

const STATUS_KEY = 'connectionStatus';

const form = document.getElementById('form');
const bridgeUrlInput = document.getElementById('bridgeUrl');
const tokenInput = document.getElementById('token');
const labelInput = document.getElementById('label');
const revealButton = document.getElementById('reveal');
const reconnectButton = document.getElementById('reconnect');
const savedNote = document.getElementById('saved');
const errorNote = document.getElementById('error');
const dot = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const statusDetail = document.getElementById('statusDetail');

const LABELS = {
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Disconnected',
  unconfigured: 'Not configured',
};

/** @param {object | undefined} status the record the worker publishes. */
function renderStatus(status) {
  const state = status && typeof status.state === 'string' ? status.state : 'unconfigured';
  dot.className = `dot ${state === 'unconfigured' ? '' : state}`;
  statusText.textContent = LABELS[state] ?? state;

  if (state === 'unconfigured') {
    statusDetail.textContent = 'Enter a bridge URL and token below, then save.';
  } else if (state === 'connected') {
    statusDetail.textContent = status.bridgeUrl ?? '';
  } else if (status && status.error) {
    statusDetail.textContent = status.error;
  } else {
    statusDetail.textContent = status && status.bridgeUrl ? status.bridgeUrl : '';
  }
}

/** Load the saved settings and the current status into the form. */
async function load() {
  const stored = await chrome.storage.local.get(['bridgeUrl', 'token', 'label', STATUS_KEY]);
  bridgeUrlInput.value = typeof stored.bridgeUrl === 'string' ? stored.bridgeUrl : '';
  tokenInput.value = typeof stored.token === 'string' ? stored.token : '';
  labelInput.value = typeof stored.label === 'string' ? stored.label : '';
  renderStatus(stored[STATUS_KEY]);
}

/** @param {string} message '' clears the line. */
function showError(message) {
  errorNote.textContent = message;
}

function flashSaved() {
  savedNote.classList.add('show');
  setTimeout(() => savedNote.classList.remove('show'), 1_500);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');

  const bridgeUrl = bridgeUrlInput.value.trim();
  const token = tokenInput.value.trim();
  const label = labelInput.value.trim();

  // Validate here rather than letting the worker fail quietly: this is the only
  // surface where the operator can see and fix a typo.
  if (bridgeUrl === '') {
    showError('A bridge URL is required.');
    return;
  }
  let parsed;
  try {
    parsed = new URL(bridgeUrl);
  } catch {
    showError('That is not a valid URL.');
    return;
  }
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
    showError('The bridge URL must start with wss:// (or ws:// for localhost).');
    return;
  }
  if (label !== '' && !/^[A-Za-z0-9._-]{1,32}$/.test(label)) {
    showError('A profile label may use letters, digits, dot, dash and underscore, up to 32 characters.');
    return;
  }
  if (token === '') {
    showError('A token is required; the harness refuses connections without one.');
    return;
  }

  await chrome.storage.local.set({ bridgeUrl, token, label });
  bridgeUrlInput.value = bridgeUrl;
  tokenInput.value = token;
  labelInput.value = label;
  flashSaved();
  // The storage listener in the worker reconnects, but the worker may be
  // asleep; this message wakes it so the operator sees the result immediately.
  chrome.runtime.sendMessage({ type: 'bridge:reconnect' }).catch(() => {});
});

reconnectButton.addEventListener('click', () => {
  showError('');
  chrome.runtime.sendMessage({ type: 'bridge:reconnect' }).catch(() => {
    showError('The extension service worker did not respond; reload the extension.');
  });
});

revealButton.addEventListener('click', () => {
  const hidden = tokenInput.type === 'password';
  tokenInput.type = hidden ? 'text' : 'password';
  revealButton.textContent = hidden ? 'Hide token' : 'Show token';
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(STATUS_KEY in changes)) return;
  renderStatus(changes[STATUS_KEY].newValue);
});

load().catch(() => showError('Could not read the saved settings.'));
