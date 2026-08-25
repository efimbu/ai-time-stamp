// ==UserScript==
// @name         AI Time Stamp
// @namespace    local.ai.time.stamp
// @version      0.4.0
// @description  Prefix composer prompts with local timestamp (Grok / ChatGPT / DeepSeek). Logs forms to console and to tmp/log.jsonl via localhost sink.
// @author       local
// @license      Apache-2.0
// @match        https://grok.com/*
// @match        https://*.grok.com/*
// @match        https://chatgpt.com/*
// @match        https://*.chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://*.chat.openai.com/*
// @match        https://chat.deepseek.com/*
// @match        https://*.deepseek.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

/**
 * OrangeMonkey / Tampermonkey template (same header + panel style as ../vk/vk-wall-capture.user.js).
 *
 * Known composers (from you / form log):
 *   grok.com              [role="textbox"][aria-label="Ask Grok anything"]
 *   chatgpt.com           #prompt-textarea [role="textbox"]
 *   chat.deepseek.com     textarea[name="search"][placeholder="Message DeepSeek"]
 *                         send: div.ds-button.ds-button--primary.ds-button--circle[role=button]
 *                         (svg path d^=M8.3125, class _52c986b)
 *
 * Disk log: run `python sink.py` (or start_sink.bat). Userscript POSTs to
 * http://127.0.0.1:8766/log → tmp/log.jsonl
 */

(function () {
  'use strict';

  const SCRIPT_VERSION = '0.4.0';
  const STORAGE_KEY = 'ai_time_stamp_v1';
  const LOG_KEY = 'ai_time_stamp_form_log';
  const SINK = 'http://127.0.0.1:8766';
  const PANEL_ID = 'ai-time-stamp-panel';
  const TS_RE = /^\[\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;
  const STYLE_ROOT_OPEN =
    'position:fixed;z-index:2147483646;right:12px;bottom:12px;width:320px;max-width:calc(100vw - 20px);max-height:calc(100vh - 24px);display:flex;flex-direction:column;background:#1b1b1f;color:#e7e7ea;border:1px solid #3a3b3c;border-radius:12px;box-shadow:0 10px 32px rgba(0,0,0,.5);font:12px/1.35 system-ui,sans-serif;overflow:hidden;user-select:none;left:auto;top:auto;opacity:1';
  const STYLE_ROOT_MINI =
    'position:fixed;z-index:2147483646;right:10px;bottom:10px;width:28px;height:28px;padding:0;display:flex;align-items:center;justify-content:center;background:#1b1b1f;color:#7a7e84;border:1px solid #3a3b3c;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.3);font:16px/1 system-ui,sans-serif;overflow:hidden;user-select:none;left:auto;top:auto;opacity:.4';

  /**
   * Built-in fallback. Live override: control/config.json via sink GET /config
   * (same idea as vk-wall-capture browser_config).
   */
  const DEFAULT_SITES = [
    {
      id: 'grok',
      host: /(^|\.)grok\.com$/i,
      match: [
        { role: 'textbox', ariaLabel: 'Ask Grok anything' },
        { role: 'textbox', ariaLabelRe: /ask grok/i },
        { role: 'textbox', ariaLabelRe: /message grok/i },
      ],
    },
    {
      id: 'chatgpt',
      host: /(^|\.)(chatgpt\.com|chat\.openai\.com)$/i,
      match: [
        { id: 'prompt-textarea', role: 'textbox' },
        { id: 'prompt-textarea' },
      ],
    },
    {
      id: 'deepseek',
      host: /(^|\.)deepseek\.com$/i,
      // React-controlled textarea: Enter/Send reads state, not DOM.
      // Stamp before submit (stop event → write → click send), and on input.
      reactControlled: true,
      match: [
        { tag: 'textarea', name: 'search', placeholder: 'Message DeepSeek' },
        { tag: 'textarea', placeholder: 'Message DeepSeek' },
        { tag: 'textarea', name: 'search', placeholderRe: /deepseek/i },
      ],
    },
  ];

  let SITES = DEFAULT_SITES.slice();

  const state = {
    enabled: true,
    logForms: true,
    syncOn: true,
    submitDelayMs: 80,
    prefixOnInput: false,
    lastAction: '',
    lastError: '',
    lastStamp: '',
    site: null,
    composer: null,
    formLog: [],
    pendingLogs: [],
    sinkOnline: null,
    collapsed: true,
  };

  let ui = {};
  let scanTimer = 0;
  let flushTimer = 0;
  let flushBusy = false;
  let lastFormSig = '';
  let replaying = false;
  let submitTimer = 0;
  const REPLAY = '__aiTimeReplay';

  function gmGet(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(key, fallback);
    } catch (_) {}
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  function gmSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, value);
        return;
      }
    } catch (_) {}
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {}
  }

  function loadPrefs() {
    const data = gmGet(STORAGE_KEY, null);
    if (!data || typeof data !== 'object') return;
    if (typeof data.enabled === 'boolean') state.enabled = data.enabled;
    if (typeof data.logForms === 'boolean') state.logForms = data.logForms;
    if (data.diskLog === false) state.syncOn = false;
    else state.syncOn = true;
    if (typeof data.collapsed === 'boolean') state.collapsed = data.collapsed;
  }

  function savePrefs() {
    gmSet(STORAGE_KEY, {
      enabled: state.enabled,
      logForms: state.logForms,
      diskLog: state.syncOn,
      collapsed: state.collapsed,
    });
  }

  function clientLog(level, message, extra) {
    const rec = Object.assign(
      {
        level: level || 'INFO',
        message: String(message || ''),
        ts: Date.now(),
        scriptVersion: SCRIPT_VERSION,
        href: location.href,
        host: location.hostname,
      },
      extra && typeof extra === 'object' ? extra : {}
    );
    state.pendingLogs.push(rec);
    if (state.pendingLogs.length > 300) {
      state.pendingLogs.splice(0, state.pendingLogs.length - 300);
    }
    try {
      console.log('[ai-time]', rec.level, rec.message, rec);
    } catch (_) {}
    if (state.syncOn) scheduleFlush(600);
    return rec;
  }

  function currentSite() {
    const host = location.hostname;
    for (let i = 0; i < SITES.length; i++) {
      const s = SITES[i];
      if (s.host && s.host.test(host)) return s;
    }
    return null;
  }

  function toRe(v, flags) {
    if (!v) return null;
    if (v instanceof RegExp) return v;
    try {
      return new RegExp(String(v), flags || 'i');
    } catch (_) {
      return null;
    }
  }

  function normalizeRule(r) {
    if (!r || typeof r !== 'object') return null;
    const out = {};
    if (r.selector) out.selector = r.selector;
    if (r.tag) out.tag = r.tag;
    if (r.id) out.id = r.id;
    if (r.role) out.role = r.role;
    if (r.name) out.name = r.name;
    if (r.placeholder) out.placeholder = r.placeholder;
    if (r.testid) out.testid = r.testid;
    const aria = r.aria_label || r.ariaLabel;
    if (aria) out.ariaLabel = aria;
    const ariaRe = r.aria_label_re || r.ariaLabelRe;
    if (ariaRe) {
      const re = toRe(ariaRe, 'i');
      if (re) out.ariaLabelRe = re;
    }
    const phRe = r.placeholder_re || r.placeholderRe;
    if (phRe) {
      const re = toRe(phRe, 'i');
      if (re) out.placeholderRe = re;
    }
    return out;
  }

  function normalizeSite(s) {
    if (!s || !s.id) return null;
    const match = Array.isArray(s.match)
      ? s.match.map(normalizeRule).filter(Boolean)
      : [];
    return {
      id: s.id,
      host: s.host ? toRe(s.host, 'i') : null,
      reactControlled: !!(s.react_controlled || s.reactControlled),
      match: match,
      send: s.send || null,
    };
  }

  function applyRemoteConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    if (Array.isArray(cfg.sites) && cfg.sites.length) {
      const next = cfg.sites.map(normalizeSite).filter(Boolean);
      if (next.length) SITES = next;
    }
    const stamp = cfg.stamp || {};
    if (typeof stamp.submit_delay_ms === 'number' && stamp.submit_delay_ms >= 0) {
      state.submitDelayMs = stamp.submit_delay_ms;
    }
    if (typeof stamp.prefix_on_input === 'boolean') {
      state.prefixOnInput = stamp.prefix_on_input;
    }
    state.site = currentSite();
    updateUI();
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function formatTimestamp(d) {
    d = d || new Date();
    return (
      '[' +
      d.getFullYear() +
      '-' +
      pad(d.getMonth() + 1) +
      '-' +
      pad(d.getDate()) +
      ' ' +
      pad(d.getHours()) +
      ':' +
      pad(d.getMinutes()) +
      ':' +
      pad(d.getSeconds()) +
      ']'
    );
  }

  function hasTimestampPrefix(text) {
    return TS_RE.test(String(text || '').trimStart());
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.closest('#' + PANEL_ID)) return false;
    const st = window.getComputedStyle(el);
    if (!st || st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') {
      return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
  }

  function attr(el, name) {
    try {
      return el.getAttribute(name) || '';
    } catch (_) {
      return '';
    }
  }

  function describeField(el) {
    const tag = (el.tagName || '').toLowerCase();
    const role = attr(el, 'role');
    const id = el.id || '';
    const name = el.name || attr(el, 'name');
    const type = (el.type || attr(el, 'type') || '').toLowerCase();
    const ariaLabel = attr(el, 'aria-label');
    const ariaPlaceholder = attr(el, 'aria-placeholder');
    const placeholder = el.placeholder || attr(el, 'placeholder');
    const contenteditable = attr(el, 'contenteditable');
    const testid = attr(el, 'data-testid');
    const cls = String(el.className || '')
      .toString()
      .trim()
      .slice(0, 180);
    return {
      tag: tag,
      id: id,
      name: name,
      type: type,
      role: role,
      ariaLabel: ariaLabel,
      ariaPlaceholder: ariaPlaceholder,
      placeholder: placeholder,
      contenteditable: contenteditable,
      testid: testid,
      className: cls,
      visible: isVisible(el),
    };
  }

  function fieldKey(d) {
    return [d.tag, d.id, d.name, d.role, d.ariaLabel, d.placeholder, d.testid, d.contenteditable].join('|');
  }

  function fieldPlaceholder(el) {
    return el.placeholder || attr(el, 'placeholder') || attr(el, 'aria-placeholder');
  }

  function matchesRule(el, rule) {
    if (!rule) return false;
    if (rule.selector) {
      try {
        if (!el.matches(rule.selector)) return false;
      } catch (_) {
        return false;
      }
    }
    if (rule.tag && (el.tagName || '').toLowerCase() !== String(rule.tag).toLowerCase()) {
      return false;
    }
    if (rule.id && el.id !== rule.id) return false;
    if (rule.role && attr(el, 'role') !== rule.role) return false;
    if (rule.ariaLabel && attr(el, 'aria-label') !== rule.ariaLabel) return false;
    if (rule.ariaLabelRe && !rule.ariaLabelRe.test(attr(el, 'aria-label') || '')) return false;
    if (rule.name && (el.name || attr(el, 'name')) !== rule.name) return false;
    if (rule.placeholder && fieldPlaceholder(el) !== rule.placeholder) return false;
    if (rule.placeholderRe && !rule.placeholderRe.test(fieldPlaceholder(el) || '')) return false;
    if (rule.testid && attr(el, 'data-testid') !== rule.testid) return false;
    return true;
  }

  function queryCandidates() {
    const sel =
      'form, input, textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="searchbox"], [role="combobox"]';
    return Array.prototype.slice.call(document.querySelectorAll(sel));
  }

  function findComposer(site) {
    const rules = site && Array.isArray(site.match) ? site.match : [];
    if (!rules.length) return null;
    const nodes = queryCandidates();
    for (let r = 0; r < rules.length; r++) {
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (!isVisible(el)) continue;
        if (matchesRule(el, rules[r])) return el;
      }
    }
    return null;
  }

  function getText(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
    return (el.innerText || el.textContent || '').replace(/\u00a0/g, ' ');
  }

  function nativeAssign(el, text) {
    const proto =
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, text);
    else el.value = text;
  }

  function nativeSetValue(el, text) {
    const prev = el.value;
    nativeAssign(el, text);
    try {
      const tracker = el._valueTracker;
      if (tracker && typeof tracker.setValue === 'function') tracker.setValue(prev);
    } catch (_) {}
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setText(el, text) {
    if (!el) return false;
    try {
      el.focus();
    } catch (_) {}
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      nativeSetValue(el, text);
      return true;
    }
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      const ok = document.execCommand('insertText', false, text);
      if (ok) return true;
    } catch (_) {}
    try {
      el.textContent = text;
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: text,
        })
      );
      return true;
    } catch (_) {
      el.textContent = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
  }

  function stampComposer(el, reason) {
    if (!state.enabled) return false;
    el = el || state.composer || findComposer(state.site);
    if (!el) return false;
    const raw = getText(el);
    if (!String(raw).trim()) return false;
    if (hasTimestampPrefix(raw)) return false;
    const ts = formatTimestamp();
    const next = ts + '\n' + raw.replace(/^\n+/, '');
    const ok = setText(el, next);
    if (ok) {
      state.lastStamp = ts;
      state.lastAction = 'stamp ' + reason + ' ' + ts;
      clientLog('INFO', 'stamped composer', {
        reason: reason,
        tsText: ts,
        siteId: state.site && state.site.id,
        field: describeField(el),
      });
      updateUI();
    }
    return ok;
  }

  function sendButtonFrom(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.closest) {
      const hit = el.closest(
        'button, [role="button"], [type="submit"], [data-testid="send-button"], .ds-button, .ds-icon-button'
      );
      if (hit) return hit;
    }
    return el.nodeType === 1 ? el : null;
  }

  function isDisabledControl(el) {
    if (!el) return true;
    if (el.disabled) return true;
    if (attr(el, 'aria-disabled') === 'true') return true;
    const cls = String(el.className || '').toLowerCase();
    return /\bdisabled\b|\bis-disabled\b/.test(cls);
  }

  function isDeepseekSendButton(el) {
    if (!el || el.nodeType !== 1) return false;
    const btn = sendButtonFrom(el) || el;
    if (!btn || btn.closest('#' + PANEL_ID)) return false;
    const spec = (state.site && state.site.send) || {
      path_d_prefix: 'M8.3125',
      class_contains: ['ds-button', 'ds-button--primary', 'ds-button--circle'],
    };
    const cls = String(btn.className || '');
    const need = spec.class_contains || [];
    if (need.length) {
      let ok = true;
      for (let i = 0; i < need.length; i++) {
        if (cls.indexOf(need[i]) < 0) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    const prefix = spec.path_d_prefix || '';
    if (prefix && btn.querySelector) {
      try {
        if (btn.querySelector('path[d^="' + prefix.replace(/"/g, '') + '"]')) return true;
      } catch (_) {}
    }
    if (/\b_52c986b\b/.test(cls) && /\bds-button\b/.test(cls)) return true;
    return false;
  }

  function looksLikeSend(el) {
    const btn = sendButtonFrom(el);
    if (!btn || btn.closest('#' + PANEL_ID)) return false;
    if (isDisabledControl(btn)) return false;
    if (isDeepseekSendButton(btn)) return true;
    const cls = String(btn.className || '').toLowerCase();
    const al = (
      attr(btn, 'aria-label') +
      ' ' +
      attr(btn, 'title') +
      ' ' +
      attr(btn, 'data-testid') +
      ' ' +
      cls +
      ' ' +
      (btn.textContent || '')
    )
      .toLowerCase()
      .trim();
    return (
      attr(btn, 'data-testid') === 'send-button' ||
      attr(btn, 'type') === 'submit' ||
      /\bsend\b/.test(al) ||
      /发送|送出/.test(al) ||
      /\bsubmit\b/.test(al) ||
      /arrow.?up/.test(al)
    );
  }

  function findSendButton(composer) {
    if (!composer) return null;
    const form = composer.closest('form');
    let scope = form || composer.parentElement;
    if (scope && !form) {
      let p = composer.parentElement;
      for (let i = 0; i < 5 && p; i++) {
        if (p.querySelector('button, [role="button"], .ds-button, path[d^="M8.3125"]')) {
          scope = p;
          break;
        }
        p = p.parentElement;
      }
    }
    if (!scope) return null;
    const path = scope.querySelector('path[d^="M8.3125"]');
    if (path && path.closest) {
      const wrap = path.closest('[role="button"], .ds-button, .ds-icon-button');
      if (wrap && isVisible(wrap) && !isDisabledControl(wrap)) return wrap;
    }
    const hashed = scope.querySelector('.ds-button._52c986b, .ds-button.ds-button--primary.ds-button--circle');
    if (hashed && isVisible(hashed) && !isDisabledControl(hashed)) return hashed;
    const buttons = Array.prototype.slice.call(
      scope.querySelectorAll('button, [role="button"], [type="submit"], .ds-button')
    );
    for (let i = 0; i < buttons.length; i++) {
      if (looksLikeSend(buttons[i]) && isVisible(buttons[i])) return buttons[i];
    }
    return null;
  }

  function isComposerEvent(e) {
    const t = e.target;
    const el = state.composer;
    if (!t || !el) return false;
    if (t === el || el.contains(t)) return true;
    if (t.closest && t.closest('textarea, [contenteditable="true"], [role="textbox"]') === el) {
      return true;
    }
    return false;
  }

  function composerNeedsStamp(el) {
    if (!state.enabled) return false;
    el = el || state.composer || findComposer(state.site);
    if (!el) return false;
    const raw = getText(el);
    if (!String(raw).trim()) return false;
    if (hasTimestampPrefix(raw)) return false;
    return true;
  }

  function isReactControlledSite() {
    return !!(state.site && state.site.reactControlled);
  }

  function replayEnter(el) {
    if (!el) return;
    const ev = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
    });
    try {
      Object.defineProperty(ev, REPLAY, { value: true });
    } catch (_) {}
    el.dispatchEvent(ev);
  }

  function afterStampSubmit(el, reason, sendBtn) {
    if (submitTimer) return;
    stampComposer(el, reason);
    submitTimer = setTimeout(function () {
      submitTimer = 0;
      replaying = true;
      try {
        if (sendBtn && !isDisabledControl(sendBtn) && isVisible(sendBtn)) {
          sendBtn.click();
        } else {
          replayEnter(el);
        }
      } catch (_) {
        replayEnter(el);
      } finally {
        replaying = false;
      }
    }, state.submitDelayMs || 80);
  }

  function onKeydown(e) {
    if (replaying || e[REPLAY]) return;
    if (!state.enabled) return;
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.isComposing || e.keyCode === 229) return;
    if (e.repeat) return;
    if (e.target && e.target.closest && e.target.closest('#' + PANEL_ID)) return;
    const el = state.composer || findComposer(state.site);
    if (!el) return;
    if (!isComposerEvent(e) && !isVisible(el)) return;
    if (!composerNeedsStamp(el)) return;
    if (isReactControlledSite()) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      afterStampSubmit(el, 'enter', findSendButton(el));
      return;
    }
    stampComposer(el, 'enter');
  }

  function onSendGesture(e) {
    if (replaying || e[REPLAY]) return;
    if (!state.enabled) return;
    if (e.target && e.target.closest && e.target.closest('#' + PANEL_ID)) return;
    const btn = sendButtonFrom(e.target);
    const isSend =
      looksLikeSend(e.target) ||
      isDeepseekSendButton(e.target) ||
      (isReactControlledSite() && btn && findSendButton(state.composer) === btn);
    if (!isSend) return;
    const el = state.composer || findComposer(state.site);
    clientLog('INFO', 'send click ' + e.type, {
      tag: e.target && e.target.tagName,
      btnClass: btn && String(btn.className || '').slice(0, 180),
      needsStamp: composerNeedsStamp(el),
    });
    if (!composerNeedsStamp(el)) return;
    if (isReactControlledSite()) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      afterStampSubmit(el, 'send-click', btn || findSendButton(el));
      return;
    }
    stampComposer(el, 'send-click');
  }

  function onInputCapture(e) {
    if (replaying) return;
    if (!state.enabled || !state.prefixOnInput) return;
    if (!isReactControlledSite()) return;
    const el = e.target;
    if (!el || (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT')) return;
    if (el.closest && el.closest('#' + PANEL_ID)) return;
    const composer = state.composer || findComposer(state.site);
    if (!composer || (el !== composer && !composer.contains(el))) return;
    const raw = getText(el);
    if (!String(raw).trim() || hasTimestampPrefix(raw)) return;
    const ts = formatTimestamp();
    const next = ts + '\n' + raw.replace(/^\n+/, '');
    nativeAssign(el, next);
    state.lastStamp = ts;
    state.lastAction = 'stamp input ' + ts;
    updateUI();
  }

  function scanForms(reason) {
    const nodes = queryCandidates();
    const fields = [];
    const seen = {};
    for (let i = 0; i < nodes.length; i++) {
      const d = describeField(nodes[i]);
      const k = fieldKey(d);
      if (seen[k]) continue;
      seen[k] = true;
      fields.push(d);
    }
    const rec = {
      at: Date.now(),
      reason: reason || 'scan',
      href: location.href,
      host: location.hostname,
      siteId: state.site ? state.site.id : null,
      n: fields.length,
      fields: fields,
    };
    const sig = fields
      .map(function (f) {
        return fieldKey(f);
      })
      .join('\n');
    const changed = sig !== lastFormSig;
    lastFormSig = sig;
    if (state.logForms && (changed || reason === 'boot' || reason === 'manual' || reason === 'menu')) {
      state.formLog.push(rec);
      if (state.formLog.length > 40) state.formLog.splice(0, state.formLog.length - 40);
      gmSet(LOG_KEY, state.formLog);
      clientLog('FORM', 'form scan n=' + fields.length + ' reason=' + rec.reason, {
        n: fields.length,
        reason: rec.reason,
        fields: fields,
      });
      try {
        console.table(
          fields.map(function (f) {
            return {
              tag: f.tag,
              id: f.id,
              name: f.name,
              role: f.role,
              ariaLabel: f.ariaLabel,
              placeholder: f.placeholder || f.ariaPlaceholder,
              ce: f.contenteditable,
              visible: f.visible,
            };
          })
        );
      } catch (_) {}
    }
    const composer = findComposer(state.site);
    state.composer = composer;
    if (composer) {
      state.lastAction = 'composer ok (' + (state.site && state.site.id) + ')';
    } else if (state.site && state.site.match && state.site.match.length) {
      state.lastAction = 'composer not found (' + state.site.id + ')';
    } else {
      state.lastAction = 'no site match — use form log';
    }
    updateUI();
    return rec;
  }

  function scheduleScan(reason, delay) {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(function () {
      scanTimer = 0;
      scanForms(reason);
    }, delay == null ? 400 : delay);
  }

  function logPayload() {
    return {
      scriptVersion: SCRIPT_VERSION,
      dumpedAt: new Date().toISOString(),
      href: location.href,
      host: location.hostname,
      site: state.site && state.site.id,
      lastAction: state.lastAction,
      lastStamp: state.lastStamp,
      scans: state.formLog,
      logs: state.pendingLogs.slice(-80),
    };
  }

  function copyLog() {
    const text = JSON.stringify(logPayload(), null, 2);
    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(text);
        state.lastAction = 'log copied (' + text.length + ' chars)';
        updateUI();
        return;
      }
    } catch (_) {}
    try {
      navigator.clipboard.writeText(text).then(function () {
        state.lastAction = 'log copied';
        updateUI();
      });
    } catch (_) {
      state.lastError = 'clipboard failed';
      updateUI();
    }
  }

  function httpRequest(method, path, body) {
    const url = SINK + path;
    return new Promise(function (resolve, reject) {
      const payload = body != null ? JSON.stringify(body) : null;
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: method,
          url: url,
          data: payload,
          headers: payload ? { 'Content-Type': 'application/json' } : {},
          timeout: 8000,
          onload: function (res) {
            resolve({ status: res.status, text: res.responseText || '' });
          },
          onerror: function () {
            reject(new Error('GM error'));
          },
          ontimeout: function () {
            reject(new Error('timeout'));
          },
        });
        return;
      }
      fetch(url, {
        method: method,
        headers: payload ? { 'Content-Type': 'application/json' } : undefined,
        body: payload,
      })
        .then(function (r) {
          return r.text().then(function (t) {
            resolve({ status: r.status, text: t });
          });
        })
        .catch(reject);
    });
  }

  function scheduleFlush(delay) {
    if (!state.syncOn) return;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(function () {
      flushTimer = 0;
      flushLogs();
    }, delay == null ? 600 : delay);
  }

  function fetchConfig() {
    return httpRequest('GET', '/config', null)
      .then(function (res) {
        if (res.status < 200 || res.status >= 300 || !res.text) return false;
        try {
          applyRemoteConfig(JSON.parse(res.text));
          return true;
        } catch (_) {
          return false;
        }
      })
      .catch(function () {
        return false;
      });
  }

  function pingSink() {
    return httpRequest('GET', '/health', null)
      .then(function (res) {
        state.sinkOnline = res.status >= 200 && res.status < 300;
        if (state.sinkOnline) state.lastError = '';
        updateUI();
        if (state.sinkOnline) fetchConfig();
        return state.sinkOnline;
      })
      .catch(function () {
        state.sinkOnline = false;
        updateUI();
        return false;
      });
  }

  function flushLogs() {
    if (!state.syncOn) return Promise.resolve();
    if (flushBusy) {
      scheduleFlush(400);
      return Promise.resolve();
    }
    const logs = state.pendingLogs.splice(0, state.pendingLogs.length);
    if (!logs.length) return Promise.resolve();
    flushBusy = true;
    return httpRequest('POST', '/log', {
      type: 'delta',
      page: location.href,
      host: location.hostname,
      siteId: state.site && state.site.id,
      scriptVersion: SCRIPT_VERSION,
      logs: logs,
    })
      .then(function (res) {
        flushBusy = false;
        state.sinkOnline = res.status >= 200 && res.status < 300;
        if (state.sinkOnline) {
          state.lastAction = 'disk +' + logs.length;
          state.lastError = '';
        } else {
          state.pendingLogs = logs.concat(state.pendingLogs).slice(0, 300);
        }
        updateUI();
      })
      .catch(function () {
        flushBusy = false;
        state.sinkOnline = false;
        state.pendingLogs = logs.concat(state.pendingLogs).slice(0, 300);
        updateUI();
      });
  }

  function el(tag, style, text) {
    const n = document.createElement(tag);
    if (style) n.setAttribute('style', style);
    if (text != null && text !== '') n.textContent = text;
    return n;
  }

  function btn(primary, compact) {
    return (
      'border:0;border-radius:8px;cursor:pointer;font:12px/1.2 system-ui,sans-serif;font-weight:650;' +
      (compact ? 'padding:6px 8px;' : 'padding:8px 10px;') +
      (primary ? 'background:#2d6cdf;color:#fff;' : 'background:#2c2d2e;color:#e7e7ea;')
    );
  }

  function fieldLine(f) {
    const bits = [f.tag];
    if (f.id) bits.push('#' + f.id);
    if (f.role) bits.push('role=' + f.role);
    if (f.ariaLabel) bits.push('aria="' + f.ariaLabel.slice(0, 48) + '"');
    if (f.name) bits.push('name=' + f.name);
    if (f.placeholder) bits.push('ph="' + String(f.placeholder).slice(0, 32) + '"');
    if (f.contenteditable) bits.push('ce=' + f.contenteditable);
    bits.push(f.visible ? 'vis' : 'hid');
    return bits.join(' ');
  }

  function updateUI() {
    if (!ui.root) return;
    const siteId = state.site ? state.site.id : 'unknown';
    ui.title.textContent = 'AI time v' + SCRIPT_VERSION;
    ui.siteSpan.textContent = 'site:' + siteId;
    ui.enSpan.textContent = state.enabled ? 'on' : 'off';
    ui.enSpan.style.color = state.enabled ? '#8bc34a' : '#ff8a80';
    if (state.sinkOnline === true) {
      ui.sinkSpan.textContent = 'sink:ok';
      ui.sinkSpan.style.color = '#8bc34a';
    } else if (state.sinkOnline === false) {
      ui.sinkSpan.textContent = 'sink:off';
      ui.sinkSpan.style.color = '#ffcc80';
    } else {
      ui.sinkSpan.textContent = 'sink:?';
      ui.sinkSpan.style.color = '#9aa0a6';
    }
    if (state.composer) {
      const d = describeField(state.composer);
      ui.compSpan.textContent =
        'composer: ' +
        (d.id ? '#' + d.id : d.ariaLabel ? d.ariaLabel : d.role || d.tag);
      ui.compSpan.style.color = '#8bc34a';
    } else {
      ui.compSpan.textContent = 'composer: —';
      ui.compSpan.style.color = '#ffcc80';
    }
    ui.actSpan.textContent = state.lastAction || '';
    ui.errSpan.style.display = state.lastError ? 'block' : 'none';
    ui.errSpan.textContent = state.lastError || '';
    ui.toggleBtn.textContent = state.enabled ? 'Stamp on' : 'Stamp off';
    ui.toggleBtn.setAttribute('style', btn(state.enabled, true));
    const last = state.formLog[state.formLog.length - 1];
    ui.logBox.textContent = last
      ? last.fields
          .filter(function (f) {
            return f.visible && (f.role === 'textbox' || f.tag === 'textarea' || f.contenteditable);
          })
          .concat(
            last.fields.filter(function (f) {
              return f.visible && !(f.role === 'textbox' || f.tag === 'textarea' || f.contenteditable);
            })
          )
          .slice(0, 18)
          .map(fieldLine)
          .join('\n') || '(no visible fields)'
      : '(no scan yet)';
  }

  function buildUI() {
    if (document.getElementById(PANEL_ID)) return;
    const root = el('div', STYLE_ROOT_OPEN);
    root.id = PANEL_ID;

    const header = el(
      'div',
      'display:flex;align-items:center;justify-content:space-between;gap:6px;padding:7px 10px;background:#222228;cursor:move;flex-shrink:0'
    );
    const title = el('div', 'font-weight:700;font-size:12px;white-space:nowrap', 'AI time');
    const minBtn = el('button', btn(false, true), '—');
    minBtn.style.padding = '3px 8px';
    minBtn.title = 'свернуть / развернуть';
    header.appendChild(title);
    header.appendChild(minBtn);

    const body = el(
      'div',
      'padding:8px 10px 10px;display:flex;flex-direction:column;gap:6px;overflow:auto;min-height:0;flex:1 1 auto'
    );
    const siteSpan = el('div', 'font-size:11px;font-weight:700;color:#90caf9', 'site:…');
    const status = el(
      'div',
      'font-size:10px;color:#9aa0a6;display:flex;flex-wrap:wrap;gap:4px 8px'
    );
    const enSpan = el('span', '', 'on');
    const sinkSpan = el('span', '', 'sink:?');
    const compSpan = el('span', '', 'composer: —');
    status.appendChild(enSpan);
    status.appendChild(sinkSpan);
    status.appendChild(compSpan);
    const actSpan = el(
      'div',
      'font-size:10px;color:#90caf9;word-break:break-word;max-height:2.6em;overflow:hidden',
      ''
    );
    const errSpan = el(
      'div',
      'font-size:10px;color:#ff8a80;word-break:break-word;display:none',
      ''
    );
    const row = el('div', 'display:grid;grid-template-columns:1fr 1fr;gap:6px');
    const toggleBtn = el('button', btn(true, true), 'Stamp on');
    const scanBtn = el('button', btn(false, true), 'Scan forms');
    row.appendChild(toggleBtn);
    row.appendChild(scanBtn);
    const row2 = el('div', 'display:grid;grid-template-columns:1fr 1fr;gap:6px');
    const stampBtn = el('button', btn(false, true), 'Stamp now');
    const copyBtn = el('button', btn(false, true), 'Copy log');
    row2.appendChild(stampBtn);
    row2.appendChild(copyBtn);
    const hint = el(
      'div',
      'font-size:9px;color:#5a5f66',
      'start_sink.bat → tmp/log.jsonl. Enter / Send prefixes timestamp.'
    );
    const logBox = el(
      'pre',
      'margin:0;font:10px/1.35 ui-monospace,Consolas,monospace;background:#121214;border:1px solid #2c2d2e;border-radius:8px;padding:6px;max-height:140px;overflow:auto;white-space:pre-wrap;word-break:break-word;color:#cfd8dc',
      ''
    );

    body.appendChild(siteSpan);
    body.appendChild(status);
    body.appendChild(actSpan);
    body.appendChild(errSpan);
    body.appendChild(row);
    body.appendChild(row2);
    body.appendChild(hint);
    body.appendChild(logBox);
    root.appendChild(header);
    root.appendChild(body);
    (document.documentElement || document.body).appendChild(root);

    function applyCollapsed() {
      const on = !!state.collapsed;
      body.style.display = on ? 'none' : 'flex';
      title.style.display = on ? 'none' : 'block';
      minBtn.textContent = on ? '+' : '—';
      if (on) {
        root.setAttribute('style', STYLE_ROOT_MINI);
        header.setAttribute(
          'style',
          'display:flex;align-items:center;justify-content:center;padding:0;margin:0;width:100%;height:100%;background:transparent;cursor:pointer;flex-shrink:0'
        );
        minBtn.setAttribute(
          'style',
          'border:0;background:transparent;color:#8a8e94;cursor:pointer;width:100%;height:100%;padding:0;margin:0;font:18px/1 system-ui,sans-serif;font-weight:500;border-radius:8px'
        );
      } else {
        root.setAttribute('style', STYLE_ROOT_OPEN);
        header.setAttribute(
          'style',
          'display:flex;align-items:center;justify-content:space-between;gap:6px;padding:7px 10px;background:#222228;cursor:move;flex-shrink:0'
        );
        minBtn.setAttribute('style', btn(false, true));
        minBtn.style.padding = '3px 8px';
      }
    }

    (function () {
      let ox = 0,
        oy = 0,
        drag = false;
      header.onmousedown = function (e) {
        if (state.collapsed || e.target === minBtn) return;
        drag = true;
        const r = root.getBoundingClientRect();
        ox = e.clientX - r.left;
        oy = e.clientY - r.top;
        root.style.right = 'auto';
        root.style.bottom = 'auto';
        root.style.left = r.left + 'px';
        root.style.top = r.top + 'px';
        e.preventDefault();
      };
      window.addEventListener('mousemove', function (e) {
        if (!drag || state.collapsed) return;
        root.style.left = Math.max(0, e.clientX - ox) + 'px';
        root.style.top = Math.max(0, e.clientY - oy) + 'px';
      });
      window.addEventListener('mouseup', function () {
        drag = false;
      });
    })();

    root.addEventListener('mouseenter', function () {
      if (state.collapsed) root.style.opacity = '0.85';
    });
    root.addEventListener('mouseleave', function () {
      if (state.collapsed) root.style.opacity = '0.4';
    });

    minBtn.onclick = function (e) {
      e.stopPropagation();
      state.collapsed = !state.collapsed;
      applyCollapsed();
      savePrefs();
    };
    header.onclick = function (e) {
      if (!state.collapsed || e.target === minBtn) return;
      state.collapsed = false;
      applyCollapsed();
      savePrefs();
    };
    toggleBtn.onclick = function () {
      state.enabled = !state.enabled;
      savePrefs();
      updateUI();
    };
    scanBtn.onclick = function () {
      scanForms('manual');
    };
    stampBtn.onclick = function () {
      stampComposer(state.composer, 'button');
    };
    copyBtn.onclick = copyLog;

    ui = {
      root: root,
      title: title,
      siteSpan: siteSpan,
      enSpan: enSpan,
      sinkSpan: sinkSpan,
      compSpan: compSpan,
      actSpan: actSpan,
      errSpan: errSpan,
      toggleBtn: toggleBtn,
      logBox: logBox,
      applyCollapsed: applyCollapsed,
    };
    applyCollapsed();
    updateUI();
  }

  function boot() {
    loadPrefs();
    state.site = currentSite();
    const savedLog = gmGet(LOG_KEY, []);
    if (Array.isArray(savedLog)) state.formLog = savedLog.slice(-40);

    buildUI();
    scanForms('boot');

    window.addEventListener('keydown', onKeydown, true);
    window.addEventListener('click', onSendGesture, true);
    window.addEventListener('pointerdown', onSendGesture, true);
    window.addEventListener('input', onInputCapture, true);
    document.addEventListener(
      'focusin',
      function (e) {
        if (!e.target || (e.target.closest && e.target.closest('#' + PANEL_ID))) return;
        const t = e.target;
        if (
          t.matches &&
          t.matches('input, textarea, [contenteditable], [role="textbox"]')
        ) {
          scheduleScan('focusin', 200);
        }
      },
      true
    );

    const mo = new MutationObserver(function () {
      scheduleScan('dom', 500);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('AI time: scan forms', function () {
        scanForms('menu');
      });
      GM_registerMenuCommand('AI time: copy form log', copyLog);
      GM_registerMenuCommand('AI time: toggle stamp', function () {
        state.enabled = !state.enabled;
        savePrefs();
        updateUI();
      });
    }

    clientLog('INFO', 'panel ready v' + SCRIPT_VERSION, {
      siteId: state.site && state.site.id,
      host: location.hostname,
    });
    pingSink();
    setInterval(function () {
      pingSink();
      if (state.pendingLogs.length) scheduleFlush(0);
    }, 4000);
    window.addEventListener('beforeunload', function () {
      flushLogs();
    });
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
