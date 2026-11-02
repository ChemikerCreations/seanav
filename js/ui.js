// Helper UI minimi: creazione elementi, toast, pannelli, avvisi, salvataggio/condivisione file, suono.

export const $ = (sel, root = document) => root.querySelector(sel);

/** h('div', {class:'x', onclick:fn}, 'testo', child...) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

// ---- toast ----
export function toast(text, { kind = '', ms = 4500, action = null } = {}) {
  const root = $('#toast-root');
  const t = h('div', { class: 'toast ' + kind }, h('span', {}, text));
  const close = () => t.remove();
  t.addEventListener('click', (e) => {
    if (e.target === t || e.target.tagName === 'SPAN') close(); // tocca il messaggio per chiuderlo
  });
  if (action) {
    t.append(
      h('button', {
        onclick: () => {
          close();
          action.run();
        },
      }, action.label)
    );
  }
  root.append(t);
  if (ms) setTimeout(close, ms);
  return close;
}

// ---- pannelli (bottom sheet) ----
let sheetStack = [];

export function openSheet(title, bodyBuilder, { dismissable = true, onClose = null } = {}) {
  const root = $('#sheet-root');
  const body = h('div', { class: 'body' });
  const close = () => {
    sheet.remove();
    back.remove();
    sheetStack = sheetStack.filter((s) => s.close !== close);
    onClose?.();
  };
  const sheet = h(
    'div',
    { class: 'sheet', role: 'dialog', 'aria-label': title },
    h('header', {}, h('span', {}, title), dismissable ? h('button', { class: 'x', 'aria-label': 'Chiudi', onclick: close }, '×') : null),
    body
  );
  const back = h('div', { class: 'backdrop', onclick: dismissable ? close : null });
  root.append(back, sheet);
  const api = { close, body, sheet };
  bodyBuilder(body, api);
  sheetStack.push(api);
  return api;
}

export function closeAllSheets() {
  [...sheetStack].forEach((s) => s.close());
}

export function confirmDialog(title, message, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    openSheet(
      title,
      (body, api) => {
        body.append(
          h('p', {}, message),
          h(
            'div',
            { class: 'row' },
            h('button', { class: 'btn grow', onclick: () => (finish(false), api.close()) }, 'Annulla'),
            h('button', { class: 'btn grow ' + (danger ? 'danger' : 'primary'), onclick: () => (finish(true), api.close()) }, okLabel)
          )
        );
      },
      { onClose: () => finish(false) }
    );
  });
}

// ---- avvisi forti (arrivo, XTE) ----
export function showAlert(text, buttons = []) {
  const root = $('#alert-root');
  root.replaceChildren();
  const a = h('div', { class: 'alert' }, h('div', {}, text), h('div', { class: 'row' }, buttons.map((b) => h('button', { class: 'btn ' + (b.cls || ''), onclick: () => { clearAlert(); b.run?.(); } }, b.label))));
  root.append(a);
}
export function clearAlert() {
  $('#alert-root').replaceChildren();
}

// ---- file ----
export function downloadFile(name, text, mime = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export const canShareFiles = () => {
  try {
    return !!navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.gpx', { type: 'application/gpx+xml' })] });
  } catch {
    return false;
  }
};

export async function shareFile(name, text, mime) {
  const file = new File([text], name, { type: mime });
  try {
    await navigator.share({ files: [file], title: name });
    return true;
  } catch (e) {
    if (e?.name === 'AbortError') return true;
    return false;
  }
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, style: { display: 'none' } });
    inp.addEventListener('change', async () => {
      const f = inp.files?.[0];
      inp.remove();
      resolve(f ? { name: f.name, text: await f.text() } : null);
    });
    inp.addEventListener('cancel', () => resolve(null));
    document.body.append(inp);
    inp.click();
  });
}

// ---- suono / vibrazione per gli allarmi ----
let actx = null;
export function unlockAudio() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch {
    /* ignora */
  }
}

export function beep(times = 3) {
  navigator.vibrate?.([300, 150, 300, 150, 300]);
  if (!actx) return;
  for (let i = 0; i < times; i++) {
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.frequency.value = 880;
    g.gain.value = 0.25;
    o.connect(g).connect(actx.destination);
    const t0 = actx.currentTime + i * 0.4;
    o.start(t0);
    o.stop(t0 + 0.25);
  }
}
