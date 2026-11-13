import { t } from '../i18n.js';
import { h, contextMenu, promptText, confirmDialog, modal, toast, announce } from './dom.js';
import { readZip, crxToZip, harScripts, isZip, isCrx, isJsName, LIMITS } from './archive.js';
import { saveSession, loadSession, clearSession, sanitizeSession } from './store.js';
import { settings, update } from './settings.js';

// Çalışma alanı: belgeler (sekmeler), sekme grupları, proje/arşiv yükleme ve oturum kaydı.

const GROUP_COLORS = ['#f7df1e', '#4ade80', '#60a5fa', '#ff9f43', '#f472b6', '#2dd4bf', '#a3a3a3'];
const MAX_FILE_BYTES = LIMITS.fileBytes;
let seq = 0;
const uid = (p) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

export function createWorkspace(app, tabbar) {
  const docs = [];
  const groups = [];
  let active = null;
  let searches = [];
  let history = [];

  const byId = (id) => docs.find((d) => d.id === id);
  const groupOf = (id) => groups.find((g) => g.id === id);

  function newDoc({ name, input = '', output = '', path = '', group = null } = {}) {
    const d = {
      id: uid('d'), name: name || t('ws.untitled', { n: docs.length + 1 }), path: path || name || '', group,
      input, output, inState: null, outState: null, marks: { in: { bookmarks: [], notes: [] }, out: { bookmarks: [], notes: [] } },
      report: null, events: [], snapshots: [], layers: [], series: [], runs: [],
    };
    docs.push(d);
    return d;
  }

  function newGroup(name) {
    const g = { id: uid('g'), name, color: GROUP_COLORS[groups.length % GROUP_COLORS.length], collapsed: false };
    groups.push(g);
    return g;
  }

  function add(opts, { activate = true } = {}) {
    const d = newDoc(opts);
    if (activate) switchTo(d.id);
    else render();
    app.persist();
    return d;
  }

  function switchTo(id) {
    const d = byId(id);
    if (!d || d === active) { render(); return; }
    if (active) app.stash(active);
    active = d;
    app.load(d);
    render();
    app.persist();
  }

  function close(id) {
    const i = docs.findIndex((d) => d.id === id);
    if (i < 0) return;
    const [d] = docs.splice(i, 1);
    if (!docs.length) newDoc({});
    if (d === active) { active = null; switchTo((docs[i] ?? docs[i - 1] ?? docs[0]).id); }
    for (const g of [...groups]) if (!docs.some((x) => x.group === g.id)) groups.splice(groups.indexOf(g), 1);
    render();
    app.persist();
  }

  async function rename(id) {
    const d = byId(id);
    if (!d) return;
    const name = await promptText(t('ws.rename'), { label: t('ws.name'), value: d.name, validate: (v) => (v.trim() ? null : t('ws.name')) });
    if (name) { d.name = name.trim().slice(0, 200); render(); app.persist(); }
  }

  async function groupDialog(id) {
    const d = byId(id);
    const name = await promptText(t('ws.newGroup'), { label: t('ws.groupName'), value: '', validate: (v) => (v.trim() ? null : t('ws.groupName')) });
    if (!name) return;
    const g = newGroup(name.trim().slice(0, 120));
    if (d) d.group = g.id;
    render();
    app.persist();
  }

  function tabMenu(d, x, y) {
    const items = [
      { label: t('ws.rename'), run: () => rename(d.id) },
      { label: t('ws.close'), run: () => close(d.id) },
      { label: t('ws.closeOthers'), run: () => { for (const o of docs.filter((o) => o !== d)) close(o.id); } },
      'sep',
      { label: t('ws.newGroup'), run: () => groupDialog(d.id) },
      ...groups.filter((g) => g.id !== d.group).map((g) => ({ label: t('ws.moveTo', { g: g.name }), run: () => { d.group = g.id; render(); app.persist(); } })),
      d.group ? { label: t('ws.ungroup'), run: () => { d.group = null; close0(); } } : null,
      d.group ? { label: t('ws.runGroup'), run: () => app.runGroup(d.group) } : null,
    ].filter(Boolean);
    const close0 = () => { for (const g of [...groups]) if (!docs.some((x) => x.group === g.id)) groups.splice(groups.indexOf(g), 1); render(); app.persist(); };
    contextMenu(x, y, items);
  }

  function render() {
    const nodes = [];
    const tabFor = (d, hidden) => {
      const g = groupOf(d.group);
      const tab = h('button', {
        type: 'button', role: 'tab', class: 'doctab', id: `doctab-${d.id}`, 'aria-selected': String(d === active), tabindex: d === active ? '0' : '-1',
        title: d.path || d.name, hidden, style: g ? `--group:${g.color}` : null, 'data-id': d.id,
      }, h('span', { class: 'doctab-name' }, d.name), d.report ? h('span', { class: 'doctab-dot', 'aria-hidden': 'true' }) : null);
      tab.addEventListener('click', () => switchTo(d.id));
      tab.addEventListener('auxclick', (e) => { if (e.button === 1) close(d.id); });
      tab.addEventListener('contextmenu', (e) => { e.preventDefault(); tabMenu(d, e.clientX, e.clientY); });
      tab.addEventListener('keydown', (e) => {
        const visible = [...tabbar.querySelectorAll('.doctab:not([hidden])')];
        const i = visible.indexOf(tab);
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const n = visible[(i + (e.key === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length];
          switchTo(n.dataset.id);
          tabbar.querySelector(`[data-id="${CSS.escape(n.dataset.id)}"]`)?.focus();
        } else if (e.key === 'Delete') { e.preventDefault(); close(d.id); }
        else if (e.key === 'F2') { e.preventDefault(); e.stopPropagation(); rename(d.id); }
        else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); e.stopPropagation(); const r = tab.getBoundingClientRect(); tabMenu(d, r.left, r.bottom); }
      });
      const x = h('button', { type: 'button', class: 'doctab-x', 'aria-label': t('ws.closeTab', { n: d.name }), tabindex: '-1', hidden, onclick: () => close(d.id) }, '×');
      return [tab, x];
    };
    const seen = new Set();
    for (const d of docs) {
      if (!d.group || seen.has(d.group)) continue;
      seen.add(d.group);
      const g = groupOf(d.group);
      if (!g) { d.group = null; continue; }
      const members = docs.filter((x) => x.group === g.id);
      const chip = h('button', { type: 'button', class: 'group-chip', style: `--group:${g.color}`, 'aria-expanded': String(!g.collapsed), title: t('ws.groupToggle') },
        h('span', { class: 'group-dot', 'aria-hidden': 'true' }), g.name, h('span', { class: 'count' }, String(members.length)));
      chip.addEventListener('click', () => { g.collapsed = !g.collapsed; render(); app.persist(); });
      chip.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          { label: t('ws.renameGroup'), run: async () => { const n = await promptText(t('ws.renameGroup'), { value: g.name, validate: (v) => (v.trim() ? null : t('ws.groupName')) }); if (n) { g.name = n.trim().slice(0, 120); render(); app.persist(); } } },
          { label: t('ws.runGroup'), run: () => app.runGroup(g.id) },
          { label: t('ws.closeGroup'), run: () => { for (const m of members) close(m.id); } },
          { label: t('ws.dissolveGroup'), run: () => { for (const m of members) m.group = null; groups.splice(groups.indexOf(g), 1); render(); app.persist(); } },
        ]);
      });
      nodes.push(h('div', { class: 'tab-group', role: 'presentation', style: `--group:${g.color}` }, chip, ...members.flatMap((m) => tabFor(m, g.collapsed && m !== active))));
    }
    for (const d of docs) if (!d.group) nodes.push(...tabFor(d, false));
    nodes.push(h('button', { type: 'button', class: 'doctab-new', 'aria-label': t('ws.newTab'), title: t('ws.newTab'), onclick: () => add({}) }, '+'));
    tabbar.replaceChildren(...nodes);
    tabbar.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // ── dosya, klasör ve arşiv yükleme ──
  async function loadFiles(files, { groupName = null } = {}) {
    const loaded = [];
    const loose = [];
    for (const f of files) {
      if (f.size > LIMITS.totalBytes) { toast(t('ws.tooBig', { n: f.name }), 'err'); continue; }
      try {
        const head = new Uint8Array(await f.slice(0, 16).arrayBuffer());
        const lower = f.name.toLowerCase();
        if (isZip(head) || isCrx(head) || /\.(zip|crx)$/.test(lower)) {
          let bytes = new Uint8Array(await f.arrayBuffer());
          if (isCrx(bytes)) bytes = crxToZip(bytes);
          const entries = (await readZip(bytes, isJsName)).slice(0, LIMITS.jsFiles);
          const g = newGroup(f.name);
          const dec = new TextDecoder();
          for (const e of entries) loaded.push(newDoc({ name: e.name.split('/').pop(), path: e.name, input: dec.decode(e.data), group: g.id }));
          if (!entries.length) { groups.splice(groups.indexOf(g), 1); toast(t('ws.noJs', { n: f.name }), 'warn'); } else offerBatch(g, entries.length);
        } else if (/\.har$/.test(lower) || (lower.endsWith('.json') && head[0] === 0x7b && f.size < LIMITS.totalBytes && /"log"\s*:/.test(await f.slice(0, 4096).text()))) {
          const scripts = harScripts(JSON.parse(await f.text()));
          if (!scripts.length) { toast(t('ws.noJs', { n: f.name }), 'warn'); continue; }
          const g = newGroup(f.name);
          for (const s of scripts) loaded.push(newDoc({ name: s.name, path: s.url, input: s.text, group: g.id }));
          offerBatch(g, scripts.length);
        } else {
          if (f.size > MAX_FILE_BYTES) { toast(t('ws.tooBig', { n: f.name }), 'err'); continue; }
          loose.push({ name: f.name, path: f.webkitRelativePath || f.relPath || f.name, text: await f.text() });
        }
      } catch (e) {
        toast(`${f.name}: ${e.message}`, 'err');
      }
    }
    if (loose.length) {
      // tek dosya: boş etkin sekmeye yükle; çoklu (klasör): proje grubu
      if (loose.length === 1 && !groupName && active && !app.text('in') && !app.text('out')) {
        active.name = loose[0].name;
        active.path = loose[0].path;
        app.setInput(loose[0].text);
        render();
      } else {
        const g = loose.length > 1 || groupName ? newGroup(groupName ?? t('ws.files', { n: loose.length })) : null;
        for (const f of loose) loaded.push(newDoc({ name: f.name, path: f.path, input: f.text, group: g?.id ?? null }));
        if (g && loose.length > 1) offerBatch(g, loose.length);
      }
    }
    if (loaded.length) switchTo(loaded[0].id);
    else render();
    app.persist();
    announce(t('ws.loaded', { n: loaded.length || loose.length }));
  }

  async function offerBatch(g, n) {
    await new Promise((r) => setTimeout(r, 0));
    if (await confirmDialog(t('ws.batchTitle'), t('ws.batchBody', { n, g: g.name }), { ok: t('ws.batchRun') })) app.runGroup(g.id);
  }

  // Sürükle-bırak klasörü: FileSystemEntry ağacı gezilir (yalnızca .js ve arşivler)
  async function filesFromDrop(dt) {
    const items = [...(dt.items ?? [])];
    const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    if (!entries.some((e) => e.isDirectory)) return { files: [...dt.files], group: null };
    const out = [];
    const walk = async (entry, prefix) => {
      if (out.length >= LIMITS.jsFiles) return;
      if (entry.isFile) {
        if (!isJsName(entry.name)) return;
        const f = await new Promise((res, rej) => entry.file(res, rej));
        f.relPath = `${prefix}${entry.name}`;
        out.push(f);
      } else if (entry.isDirectory) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) return;
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
        }
      }
    };
    for (const e of entries) await walk(e, '');
    return { files: out, group: entries.find((e) => e.isDirectory)?.name ?? null };
  }

  // ── onaylı URL'den indirme (134) ──
  async function fromUrl() {
    const result = await modal(t('url.title'), (close) => {
      const input = h('input', { class: 'field', type: 'url', autofocus: true, placeholder: 'https://example.com/app.js', spellcheck: 'false', 'aria-label': 'URL' });
      const approve = h('input', { type: 'checkbox' });
      const remember = h('input', { type: 'checkbox' });
      const hostInfo = h('p', { class: 'rep-muted small' }, t('url.privacy'));
      const err = h('p', { class: 'dlg-err', role: 'alert' });
      const approveRow = h('label', { class: 'check' }, approve, h('span', {}, t('url.approve')));
      const rememberRow = h('label', { class: 'check' }, remember, t('url.remember'));
      const parse = () => {
        try {
          const u = new URL(input.value.trim());
          if (!/^https?:$/.test(u.protocol)) return null;
          return u;
        } catch { return null; }
      };
      const sync = () => {
        const u = parse();
        const known = u && settings().approvedHosts.includes(u.host);
        approveRow.hidden = !u || known;
        rememberRow.hidden = !u || known;
        hostInfo.textContent = u ? t(known ? 'url.known' : 'url.host', { h: u.host }) : t('url.privacy');
      };
      input.addEventListener('input', sync);
      sync();
      return h('form', { class: 'dlg-body', onsubmit: (e) => {
        e.preventDefault();
        const u = parse();
        if (!u) { err.textContent = t('url.invalid'); return; }
        const known = settings().approvedHosts.includes(u.host);
        if (!known && !approve.checked) { err.textContent = t('url.needApproval'); return; }
        if (!known && remember.checked) update({ approvedHosts: [...settings().approvedHosts, u.host] });
        close(u);
      } }, input, hostInfo, approveRow, rememberRow, err,
      h('div', { class: 'dlg-actions' }, h('button', { type: 'button', class: 'ghost', onclick: () => close(undefined) }, t('ui.cancel')), h('button', { type: 'submit', class: 'ghost accent' }, t('url.fetch'))));
    });
    if (!result) return;
    app.status(t('url.fetching', { h: result.host }), 'busy');
    try {
      const res = await fetch(result.href, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_FILE_BYTES) { await reader.cancel(); throw new Error(t('url.tooBig')); }
        chunks.push(value);
      }
      const name = decodeURIComponent(result.pathname.split('/').filter(Boolean).pop() || result.host).slice(0, 120);
      const file = new File(chunks, name);
      await loadFiles([file]);
      app.status(t('url.done', { n: (size / 1024).toFixed(1) }), 'ok');
      app.networkChanged();
    } catch (e) {
      app.status(t('url.failed', { m: e.message }), 'err');
      app.networkChanged();
    }
  }

  // ── oturum ──
  function serialize() {
    if (active) app.stash(active);
    return {
      format: 'peel-session',
      version: 1,
      savedAt: new Date().toISOString(),
      active: active?.id,
      groups: groups.map(({ id, name, color, collapsed }) => ({ id, name, color, collapsed })),
      docs: docs.map((d) => ({
        id: d.id, name: d.name, path: d.path, group: d.group,
        input: d.inState ? d.inState.doc.toString() : d.input,
        output: d.outState ? d.outState.doc.toString() : d.output,
        marks: d.marks, report: d.report, events: d.events, runs: d.runs,
      })),
      searches,
      history,
    };
  }

  function restore(raw) {
    const s = sanitizeSession(raw);
    docs.length = 0;
    groups.length = 0;
    groups.push(...s.groups);
    for (const d of s.docs) docs.push({ ...d, inState: null, outState: null, snapshots: [], layers: [], series: [] });
    searches = s.searches;
    history = s.history;
    active = null;
    switchTo(s.active);
  }

  let saveTimer;
  function persist() {
    clearTimeout(saveTimer);
    if (!settings().persist) return;
    saveTimer = setTimeout(() => {
      saveSession(serialize()).catch((e) => app.log(`IndexedDB: ${e.message}`, 'warn'));
    }, 1200);
  }

  async function init() {
    if (settings().persist) {
      try {
        const saved = await loadSession();
        if (saved) { restore(saved); return true; }
      } catch (e) {
        app.log(`IndexedDB: ${e.message}`, 'warn');
      }
    }
    switchTo(newDoc({}).id);
    return false;
  }

  async function clearAll() {
    clearTimeout(saveTimer);
    await clearSession().catch(() => {});
    docs.length = 0;
    groups.length = 0;
    searches = [];
    history = [];
    active = null;
    switchTo(newDoc({}).id);
  }

  return {
    get docs() { return docs; },
    get groups() { return groups; },
    get active() { return active; },
    byId, add, switchTo, close, rename, render, loadFiles, filesFromDrop, fromUrl, serialize, restore, persist, init, clearAll,
    newGroupForActive: () => groupDialog(active?.id),
    next(d) { const i = docs.indexOf(active); switchTo(docs[(i + d + docs.length) % docs.length].id); },
    groupDocs: (gid = active?.group) => (gid ? docs.filter((d) => d.group === gid) : docs),
    searches: () => searches,
    addSearch(s) { searches = [...searches.filter((x) => x.name !== s.name), s].slice(-200); persist(); },
    searchHistory: () => history,
    pushHistory(q) { history = [q, ...history.filter((x) => x !== q)].slice(0, 50); persist(); },
  };
}
