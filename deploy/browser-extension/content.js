/**
 * content.js — page-side agent for the MV3 extension.
 *
 * Responsibilities
 *   1. snapshot: turn the live DOM into a compact, indented text outline that a
 *      language model can reason about without ever seeing pixels. Every
 *      interactive element gets a numbered `ref`.
 *   2. act: execute click / type / scroll against those refs.
 *
 * Message contract (fixed, shared with background.js):
 *   receive { command, payload }  ->  respond { result } or { error }
 *   `result` is always a human-readable string (the outline for `snapshot`,
 *   a one-line summary for the actions). Errors are strings too, and are
 *   written to be actionable by the model that will read them.
 *
 * Design notes worth knowing before you edit this file:
 *   - Plain ES2020+, no build step, no imports. It is injected as-is.
 *   - It runs in an *isolated world*. Page expandos (React internals, jQuery
 *     `$.data`, handlers installed with addEventListener) are invisible to us.
 *     That constrains click-handler detection; see `looksClickable`.
 *   - Nothing may throw out of the message listener. Every DOM access on an
 *     arbitrary site is treated as hostile: guarded, budgeted, and time-bound.
 */

'use strict';

(function () {
  // Repeated executeScript() into the same frame reuses the same isolated
  // world, so this flag survives and keeps us from registering two listeners.
  if (window.__AGENT_CONTENT_SCRIPT_INSTALLED__) return;
  window.__AGENT_CONTENT_SCRIPT_INSTALLED__ = true;

  // ---------------------------------------------------------------------------
  // Budgets. These exist because the output is spent from a model's token
  // budget, and because we run on arbitrary (sometimes pathological) pages.
  // ---------------------------------------------------------------------------
  const MAX_INTERACTIVE = 100;   // interactive lines emitted per snapshot
/** Longest single run of page text kept on one line. */
const MAX_TEXT = 300;
/** Share of the snapshot page text may fill, so controls are never starved. */
const MAX_TEXT_CHARS = 3000;
  const MAX_CHARS = 8000;        // approximate character cap on the outline
  const MAX_WALK_NODES = 25000;  // hard ceiling on elements visited per walk
  const MAX_DEPTH = 60;          // guards cyclic/absurd shadow+iframe nesting
  const MAX_NAME = 80;           // accessible name truncation
  const MAX_VALUE = 60;          // input value truncation
  const MAX_REGISTRY = 3000;     // refs retained across snapshots
  const ACTION_SETTLE_MS = 250;  // how long we watch for effects after a click

  // ---------------------------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------------------------

  /** Run `fn`, swallow anything it throws, return `fallback`. */
  function safe(fn, fallback) {
    try {
      return fn();
    } catch (_e) {
      return fallback;
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function collapse(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  function truncate(s, max) {
    s = String(s == null ? '' : s);
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  /** Quote for the outline; keeps one line and escapes embedded quotes. */
  function quote(s) {
    return '"' + collapse(s).replace(/"/g, "'") + '"';
  }

  function attr(el, name) {
    return safe(() => el.getAttribute(name), null);
  }

  function tagOf(el) {
    return safe(() => (el.tagName || '').toLowerCase(), '');
  }

  function roleOf(el) {
    const r = attr(el, 'role');
    return r ? collapse(r).toLowerCase().split(/\s+/)[0] : '';
  }

  function docOf(el) {
    return safe(() => el.ownerDocument, null) || document;
  }

  function winOf(el) {
    return safe(() => docOf(el).defaultView, null) || window;
  }

  // ---------------------------------------------------------------------------
  // Element classification tables
  // ---------------------------------------------------------------------------

  // Never descend into these: no user-visible interactive content, and some of
  // them (svg with thousands of <path>s) are pure walk-budget arson.
  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title',
    'base', 'br', 'hr', 'path', 'defs', 'clippath', 'lineargradient', 'symbol',
    'use', 'circle', 'rect', 'polygon', 'polyline', 'ellipse', 'g',
  ]);

  // ARIA roles we treat as actionable. Superset of the required
  // button/link/checkbox/radio/tab/menuitem set.
  const ROLE_KIND = {
    button: 'button',
    link: 'link',
    checkbox: 'checkbox',
    radio: 'radio',
    tab: 'tab',
    menuitem: 'menuitem',
    menuitemcheckbox: 'menuitem',
    menuitemradio: 'menuitem',
    switch: 'switch',
    combobox: 'combobox',
    listbox: 'listbox',
    textbox: 'textbox',
    searchbox: 'textbox',
    slider: 'slider',
    spinbutton: 'spinbutton',
    treeitem: 'treeitem',
    option: 'option',
  };

  // Structural landmarks worth spending a line on, tag -> label.
  const LANDMARK_TAGS = {
    main: 'main',
    nav: 'nav',
    header: 'header',
    footer: 'footer',
    aside: 'aside',
    form: 'form',
    article: 'article',
    section: 'section',
    dialog: 'dialog',
    table: 'table',
    fieldset: 'fieldset',
    details: 'details',
  };

  const LANDMARK_ROLES = {
    main: 'main',
    navigation: 'nav',
    banner: 'header',
    contentinfo: 'footer',
    complementary: 'aside',
    form: 'form',
    search: 'search',
    region: 'region',
    dialog: 'dialog',
    alertdialog: 'dialog',
    tablist: 'tablist',
    menu: 'menu',
    menubar: 'menu',
    toolbar: 'toolbar',
    alert: 'alert',
    status: 'status',
    tabpanel: 'tabpanel',
  };

  // Fields whose value must never leave the page. Deliberately does NOT include
  // a bare "auth" (matches "author") — each entry is a whole word-ish token.
  const SECRET_RE = new RegExp(
    [
      'passw?(or)?d', 'passcode', 'pwd', 'secret', 'token', 'otp', 'mfa', '2fa',
      'cvv', 'cvc', 'ccv', 'csc', 'pin', 'ssn', 'sin',
      'api[-_ ]?key', 'access[-_ ]?key', 'private[-_ ]?key', 'credential',
      'mnemonic', 'seed[-_ ]?phrase', 'security[-_ ]?code', 'verification[-_ ]?code',
      'card[-_ ]?number', 'cc[-_ ]?num', 'account[-_ ]?number', 'routing',
      'iban', 'sort[-_ ]?code',
    ].join('|'),
    'i'
  );

  const SECRET_AUTOCOMPLETE = new RegExp(
    '(current|new)-password|one-time-code|cc-number|cc-csc|cc-exp',
    'i'
  );

  // ---------------------------------------------------------------------------
  // Ref registry — the stability strategy
  // ---------------------------------------------------------------------------
  //
  // Requirements: refs must be stable *within* a snapshot and still resolvable
  // afterwards, and acting on a stale ref must fail loudly rather than hit the
  // wrong element. The scheme:
  //
  //   elementRef : WeakMap<Element, number>  — an element keeps the SAME ref
  //     across consecutive snapshots. That means a model can re-snapshot after
  //     a scroll and its earlier refs still point where it expects. The WeakMap
  //     never keeps a detached node alive.
  //
  //   refRecords : Map<number, {el: WeakRef<Element>, kind, name, snapshot}>
  //     — the resolvable side. WeakRef so a removed node can be collected; on
  //     resolve we additionally require `isConnected` and current visibility,
  //     because a detached-but-not-yet-collected node would otherwise accept
  //     clicks that go nowhere.
  //
  // Refs are allocated at *render* time, in document order, so the numbers a
  // model sees always ascend down the page.
  // ---------------------------------------------------------------------------
  const elementRef = new WeakMap();
  const refRecords = new Map();
  let nextRef = 1;
  let snapshotSerial = 0;
  let lastSnapshotSerial = 0;

  function assignRef(el, kind, name) {
    let ref = elementRef.get(el);
    if (typeof ref !== 'number') {
      ref = nextRef++;
      elementRef.set(el, ref);
    }
    refRecords.set(ref, {
      el: new WeakRef(el),
      kind: kind,
      name: name,
      snapshot: snapshotSerial,
    });
    return ref;
  }

  /** Drop dead/aged entries so the Map cannot grow without bound on SPAs. */
  function pruneRegistry() {
    if (refRecords.size <= MAX_REGISTRY) return;
    for (const [ref, rec] of refRecords) {
      const el = safe(() => rec.el.deref(), null);
      if (!el || !el.isConnected) refRecords.delete(ref);
      if (refRecords.size <= MAX_REGISTRY * 0.75) break;
    }
    // Still oversized (huge live page): drop the oldest refs.
    if (refRecords.size > MAX_REGISTRY) {
      const keys = Array.from(refRecords.keys()).sort((a, b) => a - b);
      const drop = refRecords.size - MAX_REGISTRY;
      for (let i = 0; i < drop; i++) refRecords.delete(keys[i]);
    }
  }

  /**
   * Resolve a ref to a live element or throw an actionable error.
   * Errors are phrased for the model that will read them, not for a console.
   */
  function resolveRef(ref) {
    if (typeof ref !== 'number' || !isFinite(ref)) {
      throw new Error('"ref" must be a number from the most recent snapshot.');
    }
    const rec = refRecords.get(ref);
    if (!rec) {
      throw new Error(
        'ref ' + ref + ' is unknown on this page (the page may have navigated); take a new snapshot.'
      );
    }
    const el = safe(() => rec.el.deref(), null);
    const label = rec.kind + ' ' + quote(rec.name);
    if (!el) {
      throw new Error('ref ' + ref + ' (' + label + ') has been removed from the page; take a new snapshot.');
    }
    if (!el.isConnected) {
      throw new Error(
        'ref ' + ref + ' (' + label + ') is no longer in the document; take a new snapshot.'
      );
    }
    return { el: el, rec: rec, label: label, stale: rec.snapshot !== lastSnapshotSerial };
  }

  // ---------------------------------------------------------------------------
  // Visibility
  // ---------------------------------------------------------------------------

  function styleFor(el, cache) {
    if (cache) {
      const hit = cache.get(el);
      if (hit) return hit;
    }
    const s = safe(() => winOf(el).getComputedStyle(el), null);
    if (s && cache) cache.set(el, s);
    return s;
  }

  /** Cheap per-element CSS test. Ancestors are handled by pruning the walk. */
  function isStyleVisible(style) {
    if (!style) return false;
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    const op = parseFloat(style.opacity);
    if (!isNaN(op) && op <= 0.01) return false;
    return true;
  }

  function isSemanticallyHidden(el) {
    if (attr(el, 'aria-hidden') === 'true') return true;
    if (safe(() => el.hasAttribute('inert'), false)) return true;
    // `hidden` on <details>/<dialog> is handled by CSS display anyway; treat the
    // attribute as authoritative for everything else.
    if (safe(() => el.hasAttribute('hidden'), false)) return true;
    return false;
  }

  /**
   * Full visibility check used at *action* time, where we have no walk context
   * and must therefore inspect ancestors ourselves — including across shadow
   * roots and same-origin frames, which `closest()` does not cross.
   */
  function isVisibleNow(el) {
    if (!el || !el.isConnected) return false;
    // checkVisibility (Chrome 105+) covers display/visibility/opacity/
    // content-visibility over the whole ancestor chain in one native call.
    const cv = safe(
      () =>
        typeof el.checkVisibility === 'function'
          ? el.checkVisibility({
              checkOpacity: true,
              checkVisibilityCSS: true,
              contentVisibilityAuto: true,
            })
          : null,
      null
    );
    if (cv === false) return false;
    if (cv === null && !isStyleVisible(styleFor(el, null))) return false;

    const rect = safe(() => el.getBoundingClientRect(), null);
    if (!rect) return false;
    if (rect.width <= 0 && rect.height <= 0) {
      // Zero-size is usually hidden, but some controls (a styled checkbox, a
      // file input behind a label) are legitimately 0x0 yet clickable.
      const hasBoxes = safe(() => el.getClientRects().length > 0, false);
      const tag = tagOf(el);
      if (!hasBoxes && tag !== 'input' && tag !== 'option') return false;
    }

    // aria-hidden / inert on any ancestor, hopping shadow hosts and frames.
    let node = el;
    let hops = 0;
    while (node && hops++ < 200) {
      if (node.nodeType === 1 && isSemanticallyHidden(node)) return false;
      const parent = safe(() => node.parentNode, null);
      if (parent) {
        node = parent;
        continue;
      }
      const root = safe(() => node.getRootNode(), null);
      const host = root && root.host ? root.host : null;
      if (host) {
        node = host;
        continue;
      }
      const frame = safe(() => docOf(node).defaultView.frameElement, null);
      if (frame) {
        node = frame;
        continue;
      }
      break;
    }
    return true;
  }

  function isDisabled(el) {
    if (safe(() => el.disabled === true, false)) return true;
    if (attr(el, 'aria-disabled') === 'true') return true;
    if (attr(el, 'disabled') !== null) return true;
    // <fieldset disabled> disables its descendants (except the first legend).
    const fs = safe(() => el.closest && el.closest('fieldset[disabled]'), null);
    if (fs) return true;
    return false;
  }

  // ---------------------------------------------------------------------------
  // Accessible name
  // ---------------------------------------------------------------------------
  //
  // A pragmatic subset of accname: aria-labelledby -> aria-label -> associated
  // <label> -> visible text -> placeholder -> title -> alt -> name attribute ->
  // link target. Full accname resolution is not worth the code or the cost here;
  // this ordering matches what the spec's step order produces on real pages.
  // ---------------------------------------------------------------------------

  function textOf(el) {
    // textContent, not innerText: innerText forces a reflow per call and we may
    // call this thousands of times. The cost is that we can pick up visually
    // hidden text inside a control; acceptable, and often the a11y label anyway.
    return truncate(collapse(safe(() => el.textContent, '')), MAX_NAME);
  }

  function accessibleName(el, kind) {
    return safe(() => {
      const tag = tagOf(el);

      const labelledby = attr(el, 'aria-labelledby');
      if (labelledby) {
        const root = safe(() => el.getRootNode(), document) || document;
        const parts = [];
        for (const id of labelledby.split(/\s+/)) {
          const target = safe(() => root.getElementById && root.getElementById(id), null);
          if (target) parts.push(collapse(target.textContent || ''));
        }
        const joined = collapse(parts.join(' '));
        if (joined) return truncate(joined, MAX_NAME);
      }

      const ariaLabel = collapse(attr(el, 'aria-label') || '');
      if (ariaLabel) return truncate(ariaLabel, MAX_NAME);

      // Associated <label> — `el.labels` covers for=, wrapping and implicit.
      const labels = safe(() => el.labels, null);
      if (labels && labels.length) {
        const t = collapse(Array.prototype.map.call(labels, (l) => l.textContent || '').join(' '));
        if (t) return truncate(t, MAX_NAME);
      }
      const wrapping = safe(() => el.closest && el.closest('label'), null);
      if (wrapping) {
        const t = collapse(wrapping.textContent || '');
        if (t) return truncate(t, MAX_NAME);
      }

      if (tag === 'input') {
        const type = (attr(el, 'type') || 'text').toLowerCase();
        if (type === 'button' || type === 'submit' || type === 'reset') {
          const v = collapse(safe(() => el.value, '') || '');
          if (v) return truncate(v, MAX_NAME);
          return type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '';
        }
        if (type === 'image') {
          const alt = collapse(attr(el, 'alt') || '');
          if (alt) return truncate(alt, MAX_NAME);
        }
      }

      if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
        const t = textOf(el);
        if (t) return t;
      }

      const placeholder = collapse(attr(el, 'placeholder') || '');
      if (placeholder) return truncate(placeholder, MAX_NAME);

      const title = collapse(attr(el, 'title') || '');
      if (title) return truncate(title, MAX_NAME);

      // Icon-only controls: fall back to a nested image's alt / an inline svg
      // <title>, which is how most icon buttons are labelled when they are.
      const inner = safe(() => el.querySelector && el.querySelector('img[alt], svg > title'), null);
      if (inner) {
        const t = collapse(attr(inner, 'alt') || inner.textContent || '');
        if (t) return truncate(t, MAX_NAME);
      }

      const nameAttr = collapse(attr(el, 'name') || '');
      if (nameAttr) return truncate(nameAttr, MAX_NAME);

      if (kind === 'link') {
        const href = attr(el, 'href');
        if (href) return truncate(collapse(href.split(/[?#]/)[0].split('/').filter(Boolean).pop() || href), MAX_NAME);
      }

      const id = collapse(attr(el, 'id') || '');
      if (id) return truncate(id, MAX_NAME);
      return '';
    }, '');
  }

  function isSecretField(el, name) {
    const type = (attr(el, 'type') || '').toLowerCase();
    if (type === 'password') return true;
    const ac = attr(el, 'autocomplete') || '';
    if (SECRET_AUTOCOMPLETE.test(ac)) return true;
    const haystack = [attr(el, 'name'), attr(el, 'id'), ac, name].filter(Boolean).join(' ');
    return SECRET_RE.test(haystack);
  }

  // ---------------------------------------------------------------------------
  // Interactivity classification
  // ---------------------------------------------------------------------------

  function inputKind(el) {
    const type = (attr(el, 'type') || 'text').toLowerCase();
    switch (type) {
      case 'hidden':
        return null;
      case 'checkbox':
        return 'checkbox';
      case 'radio':
        return 'radio';
      case 'button':
      case 'submit':
      case 'reset':
      case 'image':
        return 'button';
      case 'range':
        return 'slider';
      case 'file':
        return 'fileinput';
      case 'color':
        return 'colorpicker';
      default:
        return 'textbox';
    }
  }

  /**
   * Heuristic for "has a click handler". We are in an isolated world, so a
   * handler installed with addEventListener (i.e. nearly all of them) is
   * invisible to us: there is no getEventListeners() outside devtools. What we
   * can see cheaply is the `onclick` content attribute, a focusable tabindex,
   * and `cursor: pointer` — which is what authors set on their clickable divs
   * precisely so users can tell.
   *
   * `cursor` is an inherited property, so every descendant of a link reports
   * pointer. The caller therefore only asks about elements with no interactive
   * ancestor, and we additionally require a sane size and a short label so a
   * whole clickable page section does not get nominated.
   */
  function looksClickable(el, style, rect) {
    if (attr(el, 'onclick') !== null) return true;
    const ti = attr(el, 'tabindex');
    if (ti !== null && Number(ti) >= 0) return true;
    if (!style || style.cursor !== 'pointer') return false;

    const tag = tagOf(el);
    if (!/^(div|span|li|td|th|tr|p|img|label|i|b|em|strong|figure|article|section|h[1-6])$/.test(tag)) {
      return false;
    }
    if (!rect) return false;
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    if (rect.width * rect.height > vw * vh * 0.5) return false; // page-sized: not a control
    const text = collapse(safe(() => el.textContent, '') || '');
    if (text.length > 120) return false;
    return true;
  }

  /** Returns a kind string for interactive elements, otherwise null. */
  function interactiveKind(el, style, rect, hasInteractiveAncestor) {
    const tag = tagOf(el);
    const role = roleOf(el);

    // An explicit role wins over the tag: <div role="button"> is a button, and
    // <a role="tab"> should be reported as a tab.
    if (role && ROLE_KIND[role]) {
      if (role === 'option' && hasInteractiveAncestor) return null; // listbox children
      return ROLE_KIND[role];
    }
    if (role === 'presentation' || role === 'none') return null;

    switch (tag) {
      case 'a':
        return attr(el, 'href') !== null ? 'link' : null;
      case 'button':
        return 'button';
      case 'summary':
        return 'button';
      case 'select':
        return 'select';
      case 'textarea':
        return 'textarea';
      case 'input':
        return inputKind(el);
      case 'audio':
      case 'video':
        return attr(el, 'controls') !== null ? 'media' : null;
      case 'option':
      case 'label':
      case 'optgroup':
        return null; // reported through their control instead
      default:
        break;
    }

    const ce = attr(el, 'contenteditable');
    if (ce === '' || ce === 'true' || ce === 'plaintext-only') return 'editable';

    if (hasInteractiveAncestor) return null;
    if (looksClickable(el, style, rect)) return 'clickable';
    return null;
  }

  /** State tokens appended after the name, e.g. `checked disabled value="x"`. */
  function stateTokens(el, kind, name) {
    const out = [];
    const tag = tagOf(el);
    const push = (t) => {
      if (t) out.push(t);
    };

    if (isDisabled(el)) push('disabled');
    if (attr(el, 'readonly') !== null || attr(el, 'aria-readonly') === 'true') push('readonly');
    if (attr(el, 'required') !== null || attr(el, 'aria-required') === 'true') push('required');
    if (attr(el, 'aria-invalid') === 'true') push('invalid');

    const ariaChecked = attr(el, 'aria-checked');
    if (ariaChecked === 'true') push('checked');
    else if (ariaChecked === 'mixed') push('mixed');
    else if (ariaChecked === 'false' && (kind === 'checkbox' || kind === 'switch')) push('unchecked');
    else if (kind === 'checkbox' || kind === 'radio') {
      const checked = safe(() => el.checked, undefined);
      if (checked === true) push('checked');
      else if (checked === false) push('unchecked');
    }

    const sel = attr(el, 'aria-selected');
    if (sel === 'true') push('selected');
    const exp = attr(el, 'aria-expanded');
    if (exp === 'true') push('expanded');
    else if (exp === 'false') push('collapsed');
    const cur = attr(el, 'aria-current');
    if (cur && cur !== 'false') push('current');
    if (safe(() => docOf(el).activeElement === el, false)) push('focused');

    if (kind === 'link') {
      const href = attr(el, 'href') || '';
      if (href && !/^javascript:/i.test(href)) {
        // Relative form keeps the line short; same-origin absolute URLs are
        // reduced to their path so the model sees the meaningful part.
        let shown = href;
        const abs = safe(() => new URL(href, location.href), null);
        if (abs) shown = abs.origin === location.origin ? abs.pathname + abs.search + abs.hash : abs.href;
        push('-> ' + truncate(shown, 60));
      } else if (/^javascript:/i.test(href)) {
        push('-> js');
      }
      if (attr(el, 'target') === '_blank') push('newtab');
    }

    if (kind === 'textbox' || kind === 'textarea' || kind === 'editable' || kind === 'combobox') {
      const type = tag === 'input' ? (attr(el, 'type') || 'text').toLowerCase() : '';
      if (type && type !== 'text') push('type=' + type);
      const raw =
        kind === 'editable'
          ? collapse(safe(() => el.textContent, '') || '')
          : String(safe(() => el.value, '') || '');
      if (isSecretField(el, name)) {
        // Never emit a secret value; the model only needs to know it is filled.
        push(raw ? 'value=***' : 'value=""');
      } else {
        push('value=' + quote(truncate(raw, MAX_VALUE)));
      }
      const ph = collapse(attr(el, 'placeholder') || '');
      if (ph && ph !== name) push('placeholder=' + quote(truncate(ph, 40)));
    }

    if (kind === 'select') {
      const value = safe(() => {
        const o = el.selectedOptions && el.selectedOptions[0];
        return o ? collapse(o.textContent || o.value || '') : String(el.value || '');
      }, '');
      push('value=' + quote(truncate(value, MAX_VALUE)));
      const opts = safe(
        () => Array.prototype.slice.call(el.options || [], 0, 8).map((o) => collapse(o.textContent || o.value)),
        []
      );
      if (opts.length) {
        const total = safe(() => el.options.length, opts.length);
        push('options=[' + truncate(opts.join(', '), 90) + (total > opts.length ? ', …+' + (total - opts.length) : '') + ']');
      }
    }

    if (kind === 'slider' || kind === 'spinbutton') {
      const v = attr(el, 'aria-valuenow') || safe(() => String(el.value), '');
      if (v) push('value=' + v);
      const min = attr(el, 'min') || attr(el, 'aria-valuemin');
      const max = attr(el, 'max') || attr(el, 'aria-valuemax');
      if (min != null || max != null) push('range=' + (min == null ? '?' : min) + '..' + (max == null ? '?' : max));
    }

    if (kind === 'fileinput') {
      const n = safe(() => (el.files ? el.files.length : 0), 0);
      push(n ? n + ' file(s) selected' : 'no file selected');
    }

    return out;
  }

  /** Structural line for landmarks/headings, or null if the element is plumbing. */
  function structuralEntry(el) {
    const tag = tagOf(el);
    const role = roleOf(el);

    if (/^h[1-6]$/.test(tag) || role === 'heading') {
      const level = /^h([1-6])$/.test(tag) ? tag[1] : attr(el, 'aria-level') || '?';
      const text = textOf(el);
      if (!text) return null;
      return { label: 'h' + level, name: text, type: 'heading' };
    }

    let label = LANDMARK_ROLES[role] || null;
    if (!label && LANDMARK_TAGS[tag]) {
      // <section>/<article> without a label are just containers on most pages;
      // spending a line on each of them is noise.
      if ((tag === 'section' || tag === 'article') && !attr(el, 'aria-label') && !attr(el, 'aria-labelledby')) {
        return null;
      }
      label = LANDMARK_TAGS[tag];
    }
    if (!label) return null;

    const name = collapse(attr(el, 'aria-label') || '') || (tag === 'details' ? '' : '');
    const extra = [];
    if (tag === 'dialog' || role === 'dialog' || role === 'alertdialog') {
      if (safe(() => el.open === true, false) || role) extra.push('open');
      if (attr(el, 'aria-modal') === 'true') extra.push('modal');
    }
    if (tag === 'details') extra.push(safe(() => el.open === true, false) ? 'open' : 'closed');
    return { label: label, name: name, type: 'landmark', extra: extra };
  }

  // ---------------------------------------------------------------------------
  // The walk
  // ---------------------------------------------------------------------------
  //
  // One recursive pass builds a tree of "kept" entries. Hidden subtrees are
  // pruned outright (that is also how ancestor opacity/aria-hidden is handled —
  // we never reach the children). Viewport filtering, by contrast, only
  // suppresses *emission*: a container can sit off-screen while a position:fixed
  // descendant is squarely in view.
  //
  // Shadow DOM: querySelectorAll does not pierce shadow roots, so we descend
  // into `el.shadowRoot` explicitly (open roots only — closed ones are
  // unreachable by design).
  //
  // Frames: same-origin only. Cross-origin `contentDocument` access throws and
  // is skipped silently, as specified. Child-frame rects are relative to the
  // child's own viewport, so we carry an offset to keep the viewport test
  // meaningful in the top frame's coordinates.
  // ---------------------------------------------------------------------------

  function inViewport(rect, offset) {
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const top = rect.top + offset.y;
    const left = rect.left + offset.x;
    return top < vh && top + rect.height > 0 && left < vw && left + rect.width > 0;
  }

  function childrenOf(el) {
    const kids = [];
    const shadow = safe(() => el.shadowRoot, null); // null for closed roots
    if (shadow) {
      const sk = safe(() => Array.prototype.slice.call(shadow.childNodes), []);
      for (const k of sk) kids.push(k);
    }
    // childNodes, not children: an element's own text is the page's content, and
    // a walk over elements alone reports every control on a page and none of
    // what it says. Whitespace-only nodes are dropped at the visit.
    const own = safe(() => Array.prototype.slice.call(el.childNodes), []);
    for (const k of own) kids.push(k);
    return kids;
  }

  /**
   * Whether a text node falls inside the viewport. Text has no box of its own,
   * so it is measured through a Range; a node that cannot be measured is kept
   * rather than dropped, since losing content is worse than an extra line.
   * @param {Text} node @param {{x:number,y:number}} offset @returns {boolean}
   */
  function textInViewport(node, offset) {
    const rect = safe(() => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      range.detach && range.detach();
      return r;
    }, null);
    if (!rect || (rect.width <= 0 && rect.height <= 0)) return true;
    return inViewport(rect, offset);
  }

  function visit(el, parent, ctx, state) {
    if (ctx.walked++ > MAX_WALK_NODES) {
      ctx.walkOverflow = true;
      return;
    }
    if (state.depth > MAX_DEPTH) return;
    if (!el) return;
    if (el.nodeType === 3) {
      // Text under a control is that control's own label, already carried by its
      // accessible name; emitting it again would say everything twice.
      if (state.interactiveAncestor) return;
      const value = collapse(safe(() => el.nodeValue, '') || '');
      if (value === '') return;
      // A heading's text is already its name on the line above it.
      if (parent.name && parent.name === value) return;
      if (!ctx.full && !textInViewport(el, state.offset)) return;
      // Inline markup splits one sentence across several text nodes; rejoin
      // them so "<strong>1</strong> item left!" reads as one line.
      const last = parent.children[parent.children.length - 1];
      if (last && last.type === 'text' && last.value.length < MAX_TEXT) {
        last.value = truncate(last.value + ' ' + value, MAX_TEXT);
        return;
      }
      parent.children.push({ type: 'text', value: truncate(value, MAX_TEXT) });
      return;
    }
    if (el.nodeType !== 1) return;

    const tag = tagOf(el);
    if (SKIP_TAGS.has(tag)) return;
    if (isSemanticallyHidden(el)) return;

    const style = styleFor(el, ctx.styles);
    if (!isStyleVisible(style)) return;

    const rect = safe(() => el.getBoundingClientRect(), null);
    if (!rect) return;
    const zeroSize = rect.width <= 0 || rect.height <= 0;

    // --- iframes: recurse into the document, not the element -----------------
    if (tag === 'iframe' || tag === 'frame') {
      const doc = safe(() => el.contentDocument, null); // throws cross-origin
      const root = doc && safe(() => doc.documentElement, null);
      if (!root) return; // cross-origin or not yet loaded: skip silently
      const frameEntry = { type: 'landmark', label: 'iframe', name: truncate(collapse(attr(el, 'title') || attr(el, 'name') || attr(el, 'src') || ''), 60), extra: [], children: [] };
      const inner = {
        depth: state.depth + 1,
        interactiveAncestor: false,
        offset: { x: state.offset.x + rect.left, y: state.offset.y + rect.top },
      };
      const body = safe(() => doc.body, null) || root;
      for (const kid of childrenOf(body)) visit(kid, frameEntry, ctx, inner);
      if (frameEntry.children.length) parent.children.push(frameEntry);
      return;
    }

    const kind = interactiveKind(el, style, rect, state.interactiveAncestor);

    if (kind && !zeroSize) {
      ctx.totalInteractive++;
      const visible = ctx.full || inViewport(rect, state.offset);
      if (visible && ctx.collected < MAX_INTERACTIVE * 4) {
        const name = accessibleName(el, kind);
        const entry = {
          type: 'interactive',
          el: el,
          kind: kind,
          name: name,
          tokens: stateTokens(el, kind, name),
          children: [],
        };
        ctx.collected++;
        parent.children.push(entry);
        const next = { depth: state.depth + 1, interactiveAncestor: true, offset: state.offset };
        for (const kid of childrenOf(el)) visit(kid, entry, ctx, next);
        return;
      }
      // Off-screen (or over-collected): still descend, since a fixed-position
      // descendant of an off-screen container can be on-screen.
      const next = { depth: state.depth + 1, interactiveAncestor: true, offset: state.offset };
      for (const kid of childrenOf(el)) visit(kid, parent, ctx, next);
      return;
    }

    const struct = zeroSize ? null : structuralEntry(el);
    if (struct) {
      const entry = {
        type: struct.type,
        label: struct.label,
        name: struct.name,
        extra: struct.extra || [],
        onScreen: ctx.full || inViewport(rect, state.offset),
        children: [],
      };
      const next = { depth: state.depth + 1, interactiveAncestor: state.interactiveAncestor, offset: state.offset };
      for (const kid of childrenOf(el)) visit(kid, entry, ctx, next);
      parent.children.push(entry);
      return;
    }

    const next = { depth: state.depth + 1, interactiveAncestor: state.interactiveAncestor, offset: state.offset };
    for (const kid of childrenOf(el)) visit(kid, parent, ctx, next);
  }

  /**
   * Drop branches that carry nothing worth reading. A landmark survives only if
   * it contains an interactive element or a heading; headings survive on their
   * own but only when on-screen (or in full mode).
   */
  function prune(entry) {
    // Text is a leaf and carries no children to filter.
    if (entry.type === 'text') return true;
    entry.children = entry.children.filter(prune);
    if (entry.type === 'interactive') return true;
    if (entry.type === 'heading') return entry.onScreen !== false || entry.children.length > 0;
    return entry.children.length > 0;
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  //
  // Refs are allocated here, during the depth-first emit, so the numbers always
  // ascend down the page and no ref is burned on a line that got truncated away.
  // ---------------------------------------------------------------------------

  function renderTree(root, ctx) {
    const lines = [];
    let chars = 0;
    let emitted = 0;
    let textChars = 0;
    let textTruncated = false;
    const stop = { hit: false, reason: '' };

    function emit(text, depth) {
      const line = '  '.repeat(Math.max(0, depth)) + text;
      if (chars + line.length + 1 > MAX_CHARS) {
        stop.hit = true;
        stop.reason = 'character budget';
        return false;
      }
      lines.push(line);
      chars += line.length + 1;
      return true;
    }

    function walkOut(entry, depth) {
      if (stop.hit) return;
      for (const child of entry.children) {
        if (stop.hit) return;
        if (child.type === 'text') {
          // Its own budget: a wall of prose must not push the page's controls
          // out of the snapshot, which is what the model needs refs from.
          if (textChars + child.value.length > MAX_TEXT_CHARS) {
            textTruncated = true;
            continue;
          }
          if (!emit(quote(child.value), depth)) return;
          textChars += child.value.length;
          continue;
        }
        if (child.type === 'interactive') {
          if (emitted >= MAX_INTERACTIVE) {
            stop.hit = true;
            stop.reason = 'element budget';
            return;
          }
          const ref = assignRef(child.el, child.kind, child.name);
          let line = '[' + ref + '] ' + child.kind;
          if (child.name) line += ' ' + quote(child.name);
          if (child.tokens.length) line += ' ' + child.tokens.join(' ');
          if (!emit(line, depth)) return;
          emitted++;
          walkOut(child, depth + 1);
        } else {
          let line = child.label;
          if (child.name) line += ' ' + quote(child.name);
          if (child.extra && child.extra.length) line += ' ' + child.extra.join(' ');
          if (!emit(line, depth)) return;
          walkOut(child, depth + 1);
        }
      }
    }

    walkOut(root, 0);
    return { lines: lines, emitted: emitted, stop: stop, textTruncated: textTruncated };
  }

  // ---------------------------------------------------------------------------
  // snapshot
  // ---------------------------------------------------------------------------

  function buildSnapshot(payload) {
    const full = !!(payload && payload.full);
    snapshotSerial++;
    lastSnapshotSerial = snapshotSerial;

    const ctx = {
      full: full,
      styles: new Map(), // computed styles are only cached for this one pass
      walked: 0,
      walkOverflow: false,
      totalInteractive: 0,
      collected: 0,
    };
    const root = { type: 'root', children: [] };
    const startEl = document.body || document.documentElement;
    const state = { depth: 0, interactiveAncestor: false, offset: { x: 0, y: 0 } };

    if (startEl) {
      for (const kid of childrenOf(startEl)) visit(kid, root, ctx, state);
    }
    ctx.styles.clear();
    prune(root);

    const rendered = renderTree(root, ctx);
    pruneRegistry();

    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const scrollY = Math.round(window.scrollY || window.pageYOffset || 0);
    const pageH = Math.max(
      safe(() => document.documentElement.scrollHeight, 0) || 0,
      safe(() => document.body ? document.body.scrollHeight : 0, 0) || 0
    );

    const header = [];
    header.push('Page: ' + (collapse(document.title) || '(untitled)'));
    header.push('URL: ' + location.href);
    header.push(
      'View: ' +
        (full ? 'whole document' : 'viewport only (pass full:true for the whole page)') +
        ' | viewport ' + vw + 'x' + vh +
        ' | scrolled ' + scrollY + '/' + Math.max(pageH - vh, 0) + 'px'
    );
    header.push('Legend: [n] = ref — use it with click/type. Quoted lines with no ref are page text. Indentation = page structure.');

    const footer = [];
    if (rendered.stop.hit) {
      footer.push(
        'TRUNCATED (' + rendered.stop.reason + '): showing ' + rendered.emitted + ' of ' +
          ctx.totalInteractive + ' interactive elements found' +
          (full ? '' : ' in the viewport') +
          '. Scroll, or act on what is listed and re-snapshot.'
      );
    } else if (!full && ctx.totalInteractive > rendered.emitted) {
      footer.push(
        'Note: ' + (ctx.totalInteractive - rendered.emitted) +
          ' further interactive elements exist outside the viewport; scroll or use full:true.'
      );
    }
    if (rendered.textTruncated) {
      footer.push('Note: some page text was left out to keep room for the interactive elements.');
    }
    if (ctx.walkOverflow) {
      footer.push('Note: the page is very large; the scan stopped after ' + MAX_WALK_NODES + ' elements.');
    }
    if (!rendered.lines.length) {
      footer.push(
        'No interactive elements were found' + (full ? ' on this page.' : ' in the current viewport — try scrolling or full:true.')
      );
    }
    footer.push('Values of password/secret fields are masked as ***.');

    return header.join('\n') + '\n\n' + rendered.lines.join('\n') + (footer.length ? '\n\n' + footer.join('\n') : '');
  }

  // ---------------------------------------------------------------------------
  // Action plumbing
  // ---------------------------------------------------------------------------

  /** Bring `el` into view, including through nested same-origin frames. */
  function scrollRefIntoView(el) {
    safe(() => el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }), null);
    // If the element lives in a frame, the parent must also scroll the frame in.
    let frame = safe(() => winOf(el).frameElement, null);
    let hops = 0;
    while (frame && hops++ < 10) {
      safe(() => frame.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }), null);
      frame = safe(() => winOf(frame).frameElement, null);
    }
  }

  /**
   * Fire a realistic pointer/mouse sequence and then `el.click()`.
   *
   * Why both: many custom widgets (drag handles, menus, canvas-backed grids)
   * only listen for pointerdown/mouseup and never see a bare `.click()`;
   * conversely, synthetic mouse events do NOT produce an activation click, so a
   * plain <button onclick> needs the explicit `.click()`. Firing the pointer
   * sequence first and `.click()` last yields exactly one activation for normal
   * elements while still waking the stubborn ones.
   */
  function dispatchRealClick(el) {
    const win = winOf(el);
    const rect = safe(() => el.getBoundingClientRect(), null) || { left: 0, top: 0, width: 0, height: 0 };
    const cx = Math.round(rect.left + rect.width / 2);
    const cy = Math.round(rect.top + rect.height / 2);
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: win,
      clientX: cx,
      clientY: cy,
      screenX: cx,
      screenY: cy,
      button: 0,
      detail: 1,
    };
    const pointer = Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1 }, base);
    const PE = win.PointerEvent || null;
    const ME = win.MouseEvent || MouseEvent;

    const fire = (Ctor, type, init) => {
      if (!Ctor) return;
      safe(() => el.dispatchEvent(new Ctor(type, init)), null);
    };

    fire(PE, 'pointerover', Object.assign({}, pointer, { buttons: 0 }));
    fire(ME, 'mouseover', Object.assign({}, base, { buttons: 0 }));
    fire(PE, 'pointermove', Object.assign({}, pointer, { buttons: 0 }));
    fire(ME, 'mousemove', Object.assign({}, base, { buttons: 0 }));
    fire(PE, 'pointerdown', Object.assign({}, pointer, { buttons: 1 }));
    fire(ME, 'mousedown', Object.assign({}, base, { buttons: 1 }));
    safe(() => el.focus && el.focus({ preventScroll: true }), null);
    fire(PE, 'pointerup', Object.assign({}, pointer, { buttons: 0 }));
    fire(ME, 'mouseup', Object.assign({}, base, { buttons: 0 }));

    // The real activation. Guarded because the handlers above may already have
    // navigated away or detached the node.
    safe(() => {
      if (el.isConnected && typeof el.click === 'function') el.click();
    }, null);
  }

  /**
   * Is something painted on top of the element's centre? Purely informational —
   * we still dispatch, because overlay detection has false positives (the hit
   * element is often a child, a ::before, or a same-widget wrapper).
   */
  function occludedBy(el) {
    return safe(() => {
      const rect = el.getBoundingClientRect();
      const cx = Math.round(rect.left + rect.width / 2);
      const cy = Math.round(rect.top + rect.height / 2);
      if (cx < 0 || cy < 0 || cx > (window.innerWidth || 0) || cy > (window.innerHeight || 0)) return null;
      const root = el.getRootNode();
      const hit = (root && root.elementFromPoint ? root : document).elementFromPoint(cx, cy);
      if (!hit || hit === el) return null;
      if (el.contains(hit) || hit.contains(el)) return null;
      const name = accessibleName(hit, '') || tagOf(hit);
      return truncate(collapse(name), 40) || tagOf(hit);
    }, null);
  }

  /** Watch the page for the usual "something happened" signals. */
  function beginChangeWatch() {
    const before = { url: location.href, title: document.title };
    let mutations = 0;
    let observer = null;
    safe(() => {
      observer = new MutationObserver((records) => {
        mutations += records.length;
      });
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: false,
      });
    }, null);
    return {
      async finish(waitMs) {
        await sleep(waitMs == null ? ACTION_SETTLE_MS : waitMs);
        safe(() => observer && observer.disconnect(), null);
        const parts = [];
        if (location.href !== before.url) parts.push('URL is now ' + location.href);
        else if (document.title !== before.title) parts.push('page title is now ' + quote(document.title));
        else if (mutations > 0) parts.push('page updated (' + mutations + ' DOM changes)');
        else parts.push('no page change detected');
        return parts.join('; ');
      },
    };
  }

  // ---------------------------------------------------------------------------
  // click
  // ---------------------------------------------------------------------------

  async function doClick(payload) {
    const ref = payload && payload.ref;
    const { el, label, stale } = resolveRef(ref);

    scrollRefIntoView(el);
    if (!isVisibleNow(el)) {
      throw new Error(
        'ref ' + ref + ' (' + label + ') is in the document but not visible (hidden, collapsed or zero-sized); take a new snapshot.'
      );
    }
    if (isDisabled(el)) {
      throw new Error('ref ' + ref + ' (' + label + ') is disabled and cannot be clicked.');
    }

    const overlay = occludedBy(el);
    const watch = beginChangeWatch();
    dispatchRealClick(el);
    const change = await watch.finish();

    const notes = [];
    if (stale) notes.push('ref came from an earlier snapshot');
    if (overlay) notes.push('possibly covered by ' + quote(overlay));
    return (
      'Clicked [' + ref + '] ' + label + '. ' + change + '.' +
      (notes.length ? ' (' + notes.join('; ') + ')' : '')
    );
  }

  // ---------------------------------------------------------------------------
  // type
  // ---------------------------------------------------------------------------

  /**
   * Set an <input>/<textarea> value the way a framework will notice.
   *
   * The naive `el.value = x` is not enough for React: React installs a
   * "value tracker" on the node that caches the last value it saw, and when our
   * synthetic `input` event arrives it compares node.value with that cache. If
   * the assignment went through React's own property descriptor the cache is
   * updated in lockstep, the comparison says "unchanged", and onChange never
   * fires — the classic silently-ignored automated fill.
   *
   * Calling the *prototype's* native setter writes the DOM value while leaving
   * any framework-installed instance descriptor (and its cache) untouched, so
   * the subsequent `input` event reads as a genuine user edit. Vue's v-model,
   * Angular's ControlValueAccessor and Svelte bindings all key off the same
   * `input`/`change` events, so they are satisfied by the same sequence.
   *
   * Caveat specific to this file: a content script runs in an isolated world,
   * where page-installed expandos and descriptors are not visible anyway, so the
   * plain assignment would often have worked here. We use the native setter
   * regardless — it is correct in both worlds, and this code gets copied into
   * MAIN-world injections where the distinction is load-bearing.
   */
  function setNativeValue(el, value) {
    const win = winOf(el);
    const proto =
      tagOf(el) === 'textarea'
        ? (win.HTMLTextAreaElement || HTMLTextAreaElement).prototype
        : (win.HTMLInputElement || HTMLInputElement).prototype;
    const desc = safe(() => Object.getOwnPropertyDescriptor(proto, 'value'), null);
    if (desc && desc.set) desc.set.call(el, value);
    else safe(() => { el.value = value; }, null);

    // Belt and braces for MAIN-world use: nudge React's tracker directly if it
    // happens to be reachable. Invisible (and harmless) from an isolated world.
    safe(() => {
      const tracker = el._valueTracker;
      if (tracker && typeof tracker.setValue === 'function') tracker.setValue('');
    }, null);
  }

  function fireInputEvents(el, text) {
    const win = winOf(el);
    const InputEventCtor = win.InputEvent || InputEvent;
    safe(
      () =>
        el.dispatchEvent(
          new InputEventCtor('input', { bubbles: true, composed: true, inputType: 'insertText', data: text })
        ),
      null
    );
    safe(() => el.dispatchEvent(new Event('change', { bubbles: true })), null);
  }

  async function doType(payload) {
    const ref = payload && payload.ref;
    const text = payload && payload.text != null ? String(payload.text) : '';
    const submit = !!(payload && payload.submit);
    const { el, label, stale } = resolveRef(ref);

    scrollRefIntoView(el);
    if (!isVisibleNow(el)) {
      throw new Error('ref ' + ref + ' (' + label + ') is not visible; take a new snapshot.');
    }
    if (isDisabled(el) || attr(el, 'readonly') !== null) {
      throw new Error('ref ' + ref + ' (' + label + ') is disabled or read-only and cannot be typed into.');
    }

    const tag = tagOf(el);
    const secret = isSecretField(el, label);
    const shown = secret ? '***' : quote(truncate(text, 60));
    const watch = beginChangeWatch();
    let how;

    if (tag === 'select') {
      // Typing into a <select> means "choose this option".
      const options = safe(() => Array.prototype.slice.call(el.options || []), []);
      const want = collapse(text).toLowerCase();
      const match =
        options.find((o) => collapse(o.textContent || '').toLowerCase() === want) ||
        options.find((o) => String(o.value).toLowerCase() === want) ||
        options.find((o) => collapse(o.textContent || '').toLowerCase().indexOf(want) !== -1);
      if (!match) {
        throw new Error(
          'ref ' + ref + ' (' + label + ') has no option matching ' + quote(text) +
            '. Available: ' + truncate(options.map((o) => collapse(o.textContent || o.value)).join(', '), 200)
        );
      }
      safe(() => { el.value = match.value; }, null);
      safe(() => { match.selected = true; }, null);
      safe(() => el.dispatchEvent(new Event('input', { bubbles: true })), null);
      safe(() => el.dispatchEvent(new Event('change', { bubbles: true })), null);
      how = 'Selected ' + quote(collapse(match.textContent || match.value)) + ' in [' + ref + '] ' + label;
    } else if (attr(el, 'contenteditable') !== null || safe(() => el.isContentEditable === true, false)) {
      safe(() => el.focus({ preventScroll: true }), null);
      const doc = docOf(el);
      const win = winOf(el);
      // Replace the whole contents: select all, then insertText so rich editors
      // (Draft, ProseMirror, Quill) see a normal beforeinput/input pair.
      safe(() => {
        const sel = win.getSelection();
        const range = doc.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      }, null);
      const ok = safe(() => doc.execCommand('insertText', false, text), false);
      if (!ok) {
        safe(() => { el.textContent = text; }, null);
        fireInputEvents(el, text);
      }
      how = 'Typed ' + shown + ' into [' + ref + '] ' + label;
    } else if (tag === 'input' || tag === 'textarea') {
      safe(() => el.focus({ preventScroll: true }), null);
      setNativeValue(el, text);
      fireInputEvents(el, text);
      how = 'Typed ' + shown + ' into [' + ref + '] ' + label;
    } else {
      throw new Error(
        'ref ' + ref + ' (' + label + ') is not a text field; use click for it, or take a new snapshot to find the input.'
      );
    }

    let submitNote = '';
    if (submit) {
      submitNote = ' ' + pressEnter(el);
    }
    const change = await watch.finish(submit ? 400 : ACTION_SETTLE_MS);
    return how + '.' + submitNote + ' ' + change + '.' + (stale ? ' (ref came from an earlier snapshot)' : '');
  }

  /**
   * Enter: send real key events first (search boxes and comboboxes usually act
   * on keydown), then fall back to submitting the owning form only if nothing
   * cancelled the keydown — otherwise we would double-submit a form whose own
   * handler already ran.
   */
  function pressEnter(el) {
    const win = winOf(el);
    const KE = win.KeyboardEvent || KeyboardEvent;
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    let prevented = false;
    safe(() => {
      const down = new KE('keydown', init);
      const delivered = el.dispatchEvent(down);
      if (!delivered) prevented = true;
    }, null);
    safe(() => el.dispatchEvent(new KE('keypress', init)), null);
    safe(() => el.dispatchEvent(new KE('keyup', init)), null);

    if (prevented) return 'Pressed Enter (handled by the page).';
    const form = safe(() => el.form, null);
    if (form) {
      const submitted = safe(() => {
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
        return true;
      }, false);
      return submitted ? 'Pressed Enter and submitted the form.' : 'Pressed Enter.';
    }
    return 'Pressed Enter.';
  }

  // ---------------------------------------------------------------------------
  // scroll
  // ---------------------------------------------------------------------------

  /** The window, or the biggest scrollable container under the viewport centre. */
  function findScroller() {
    const de = document.scrollingElement || document.documentElement;
    const vh = window.innerHeight || 0;
    if (de && de.scrollHeight > de.clientHeight + 2) return { el: null, label: 'page' };

    const cx = Math.round((window.innerWidth || 0) / 2);
    const cy = Math.round(vh / 2);
    let node = safe(() => document.elementFromPoint(cx, cy), null);
    let hops = 0;
    while (node && hops++ < 40) {
      const style = styleFor(node, null);
      const oy = style ? style.overflowY : '';
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && node.scrollHeight > node.clientHeight + 2) {
        return { el: node, label: 'scrollable container' };
      }
      node = safe(() => node.parentElement || (node.getRootNode() && node.getRootNode().host) || null, null);
    }
    return { el: null, label: 'page' };
  }

  async function doScroll(payload) {
    const direction = payload && payload.direction;
    if (direction !== 'up' && direction !== 'down') {
      throw new Error('scroll requires direction "up" or "down".');
    }
    const vh = window.innerHeight || document.documentElement.clientHeight || 600;
    let amount = payload && typeof payload.amount === 'number' && isFinite(payload.amount) ? payload.amount : 0.8;
    if (amount <= 0) amount = 0.8;
    // `amount` is a fraction of the viewport; a caller passing a pixel count
    // (anything > 10) clearly means pixels, so accept that too.
    const delta = amount > 10 ? Math.round(amount) : Math.round(vh * amount);
    const signed = direction === 'down' ? delta : -delta;

    const target = findScroller();
    const before = target.el ? target.el.scrollTop : window.scrollY || window.pageYOffset || 0;

    if (target.el) safe(() => target.el.scrollBy({ top: signed, behavior: 'instant' }), null);
    else safe(() => window.scrollBy({ top: signed, behavior: 'instant' }), null);

    await sleep(120); // let smooth-scroll polyfills / lazy loaders settle
    const after = target.el ? target.el.scrollTop : window.scrollY || window.pageYOffset || 0;
    const max = target.el
      ? target.el.scrollHeight - target.el.clientHeight
      : Math.max(
          (safe(() => document.documentElement.scrollHeight, 0) || 0) - vh,
          0
        );
    const moved = Math.round(after - before);

    if (moved === 0) {
      return (
        'Did not scroll ' + direction + ': already at the ' + (direction === 'down' ? 'bottom' : 'top') +
        ' of the ' + target.label + ' (' + Math.round(after) + '/' + Math.round(max) + 'px).'
      );
    }
    const pct = max > 0 ? Math.round((after / max) * 100) : 100;
    return (
      'Scrolled ' + direction + ' ' + Math.abs(moved) + 'px in the ' + target.label + '. Now at ' +
      Math.round(after) + '/' + Math.round(max) + 'px (' + pct + '%). Take a new snapshot to see what is in view.'
    );
  }

  // ---------------------------------------------------------------------------
  // Message listener
  // ---------------------------------------------------------------------------

  async function handle(command, payload) {
    switch (command) {
      case 'snapshot':
        return buildSnapshot(payload || {});
      case 'click':
        return await doClick(payload || {});
      case 'type':
        return await doType(payload || {});
      case 'scroll':
        return await doScroll(payload || {});
      case 'ping':
        // Not part of the contract, but lets background.js check whether this
        // frame already has a live content script before injecting again.
        return 'pong ' + location.href;
      default:
        throw new Error(
          'unknown command ' + JSON.stringify(command) + '; supported: snapshot, click, type, scroll.'
        );
    }
  }

  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) {
    // Not running as an extension content script (e.g. pasted into a console).
    // Expose the API so the file is still testable, and stop here.
    window.__agentAction = handle;
    return;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // Ignore traffic that is not ours (other extensions' relays, devtools, etc.)
    if (!message || typeof message !== 'object' || typeof message.command !== 'string') return;

    // The listener itself must never throw, and must never leave the caller
    // hanging: every path resolves through sendResponse exactly once.
    let replied = false;
    const reply = (value) => {
      if (replied) return;
      replied = true;
      // The channel can already be gone if the page navigated mid-action.
      safe(() => sendResponse(value), null);
    };

    try {
      handle(message.command, message.payload).then(
        (result) => reply({ result: result }),
        (err) => reply({ error: (err && err.message) || String(err) })
      );
    } catch (err) {
      reply({ error: (err && err.message) || String(err) });
    }

    // Keep the message channel open for the async reply above.
    return true;
  });

  // A navigation invalidates every ref: the old nodes are gone and reusing a
  // number against a re-rendered page would be worse than failing. SPAs replace
  // the DOM without firing this, which is why resolveRef also checks isConnected.
  window.addEventListener(
    'pagehide',
    () => {
      refRecords.clear();
      lastSnapshotSerial = -1;
    },
    { capture: true }
  );
})();
