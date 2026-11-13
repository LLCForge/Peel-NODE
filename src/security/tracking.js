// E113: script değişim takibi. Aynı etiketli betiğin (ör. URL ya da dosya adı) her analizi bir anlık görüntü
// olarak saklanır; bir önceki sürümle karşılaştırılıp hash, IOC, şüpheli API, davranış sınıfı, risk ve
// satır farkı raporlanır. Geçmiş oturum belleğindedir; JSON olarak dışa/içe aktarılarak süreklilik sağlanır.
import { fnv1a } from '../util/hash.js';

export function snapshot({ label, report, output }) {
  const iocs = report?.iocs ?? {};
  return {
    label,
    time: new Date().toISOString(),
    outputHash: fnv1a(output),
    size: output.length,
    lines: output.split('\n').length,
    risk: report?.threat?.risk?.score ?? 0,
    classes: (report?.threat?.classes ?? []).map((c) => c.id),
    domains: iocs.domains ?? [],
    urls: iocs.urls ?? [],
    ips: iocs.ips ?? [],
    apis: (report?.apis ?? []).map((a) => a.name),
    tools: (report?.fingerprint ?? []).map((f) => f.name),
    // satır karmaları: içerik saklamadan satır düzeyinde fark
    lineHashes: output.split('\n').map((l) => fnv1a(l.trim())).slice(0, 50000),
  };
}

const delta = (a = [], b = []) => ({ added: b.filter((x) => !a.includes(x)), removed: a.filter((x) => !b.includes(x)) });

export function compareSnapshots(prev, cur) {
  const count = (list) => list.reduce((m, h) => m.set(h, (m.get(h) ?? 0) + 1), new Map());
  const pc = count(prev.lineHashes);
  let same = 0;
  for (const h of cur.lineHashes) { const n = pc.get(h) ?? 0; if (n) { same++; pc.set(h, n - 1); } }
  const changes = {
    changed: prev.outputHash !== cur.outputHash,
    linesAdded: cur.lineHashes.length - same,
    linesRemoved: prev.lineHashes.length - same,
    riskDelta: cur.risk - prev.risk,
    domains: delta(prev.domains, cur.domains),
    urls: delta(prev.urls, cur.urls),
    ips: delta(prev.ips, cur.ips),
    apis: delta(prev.apis, cur.apis),
    classes: delta(prev.classes, cur.classes),
    tools: delta(prev.tools, cur.tools),
  };
  const alerts = [];
  if (changes.domains.added.length || changes.urls.added.length || changes.ips.added.length) alerts.push('yeni ağ hedefi');
  if (changes.classes.added.length) alerts.push(`yeni davranış: ${changes.classes.added.join(', ')}`);
  if (changes.apis.added.some((a) => /eval|Function|sendBeacon|WebSocket|document\.cookie|fetch|XMLHttpRequest/.test(a))) alerts.push('yeni hassas API');
  if (changes.riskDelta >= 15) alerts.push(`risk +${changes.riskDelta}`);
  if (changes.tools.added.length) alerts.push(`gizleme değişti: ${changes.tools.added.join(', ')}`);
  return { from: prev.time, to: cur.time, ...changes, alerts };
}

export function createTracker(initial = {}) {
  const history = new Map(Object.entries(initial));
  return {
    record(snap) {
      const list = history.get(snap.label) ?? [];
      const prev = list[list.length - 1] ?? null;
      list.push(snap);
      history.set(snap.label, list.slice(-50));
      return prev ? compareSnapshots(prev, snap) : null;
    },
    labels: () => [...history.keys()],
    history: (label) => [...(history.get(label) ?? [])],
    export: () => JSON.stringify({ peel: 'tracking', version: 1, history: Object.fromEntries(history) }, null, 2),
    import(json) {
      const data = JSON.parse(json);
      if (data?.peel !== 'tracking' || typeof data.history !== 'object') throw new Error('PEEL takip dosyası değil');
      let n = 0;
      for (const [label, list] of Object.entries(data.history)) {
        if (!Array.isArray(list)) continue;
        const clean = list.filter((s) => s && typeof s.outputHash === 'string' && Array.isArray(s.lineHashes)).map((s) => ({
          label: String(label).slice(0, 300), time: String(s.time ?? ''), outputHash: s.outputHash, size: Number(s.size) || 0, lines: Number(s.lines) || 0,
          risk: Number(s.risk) || 0, classes: (s.classes ?? []).map(String), domains: (s.domains ?? []).map(String), urls: (s.urls ?? []).map(String),
          ips: (s.ips ?? []).map(String), apis: (s.apis ?? []).map(String), tools: (s.tools ?? []).map(String), lineHashes: s.lineHashes.map(String),
        }));
        history.set(String(label).slice(0, 300), [...(history.get(label) ?? []), ...clean].slice(-50));
        n += clean.length;
      }
      return n;
    },
  };
}
