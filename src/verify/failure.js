// E721: başarısız kanıt raporu — hangi denetim başarısız oldu, karşı örnek, ayrışan etkiler, şüpheli pass'ler ve
// yeniden üretim adımları; makine okunur nesne + paylaşılabilir Markdown.

const fmt = (v) => {
  try { return JSON.stringify(v); } catch { return String(v); }
};

export function failureReport(verification, events = []) {
  const failures = [];
  const suspects = [...new Set(events.filter((e) => e.state === 'ok' && e.observation).map((e) => e.id))];
  const c = verification?.checks ?? {};
  if (c.trace && !c.trace.equivalent) {
    failures.push({ check: 'iz denkliği', summary: `${c.trace.index}. gözlenebilir etkide ayrışma`, evidence: { girdi: c.trace.a, çıktı: c.trace.b } });
  }
  if (c.effects && !c.effects.equal) {
    failures.push({ check: 'etki farkı', summary: `${c.effects.summary.add} eklenen, ${c.effects.summary.del} silinen, ${c.effects.summary.change} değişen etki`, evidence: c.effects.ops.slice(0, 10) });
  }
  if (c.bisimulation && !c.bisimulation.bisimilar) {
    const s = c.bisimulation.steps.find((x) => !x.same);
    failures.push({ check: 'bisimülasyon', summary: `ilişki "${c.bisimulation.brokenAt}" adımında kırıldı`, evidence: s?.diff ?? null });
  }
  for (const p of c.functions?.pairs ?? []) {
    if (p.status !== 'differs') continue;
    failures.push({ check: 'fonksiyon denkliği', summary: `${p.a} ↔ ${p.b} farklı sonuç`, counterexample: p.minimized ?? p.counterexample, evidence: p.results ?? null, proof: p.proof ?? null });
  }
  if (c.fuzz && !c.fuzz.equivalent) {
    const d = c.fuzz.divergences[0];
    failures.push({ check: 'diferansiyel fuzz', summary: `${c.fuzz.divergences.length} ortamda ayrışma`, counterexample: d?.minimized ?? d?.env, evidence: d?.diff?.ops?.slice(0, 10) ?? null });
  }
  if (c.determinism && !c.determinism.deterministic) failures.push({ check: 'determinizm', summary: 'aynı yapılandırmayla farklı davranış', evidence: c.determinism.hashes });
  return {
    ok: failures.length === 0,
    failures,
    suspects,
    reproduce: failures.length ? [
      'Aynı sandbox ayarlarıyla (rapordaki "settings") girdiyi ve çıktıyı çalıştırın.',
      'Karşı örnekteki ortamı/argümanları uygulayın; etki listelerini karşılaştırın.',
      suspects.length ? `Şüpheli gözlem pass'lerini tek tek kapatın: ${suspects.join(', ')}.` : 'Pass\'leri tek tek kapatarak farkı üreten dönüşümü bulun.',
    ] : [],
  };
}

export function failureMarkdown(rep) {
  if (rep.ok) return '## Doğrulama\n\nTüm denetimler geçti.\n';
  const lines = ['## Başarısız kanıt raporu', ''];
  rep.failures.forEach((f, i) => {
    lines.push(`### ${i + 1}. ${f.check}`, '', f.summary, '');
    if (f.counterexample != null) lines.push('Karşı örnek:', '', '```json', fmt(f.counterexample), '```', '');
    if (f.evidence != null) lines.push('Kanıt:', '', '```json', fmt(f.evidence).slice(0, 4000), '```', '');
  });
  if (rep.suspects.length) lines.push(`Şüpheli pass'ler: ${rep.suspects.join(', ')}`, '');
  lines.push('Yeniden üretim:', '', ...rep.reproduce.map((s, i) => `${i + 1}. ${s}`), '');
  return lines.join('\n');
}
