import { parseRules, rulesPlugin } from '../../integrations/rules.js';
import { verifyPlugin, fingerprint } from '../../integrations/signing.js';
import { importPluginSource } from '../../integrations/plugins.js';
import { h, tx, busy, pickFiles, readText, field } from './dom.js';

// H165/H166/H167 arayüzü: dönüşüm kuralları ve imzalı eklentiler. Etkin olanlar bir sonraki "Çöz"de
// pipeline'a eklenir (main.js: plugins: integrations.plugins()). İmzası doğrulanmayan ya da güvenilen
// anahtarlar listesinde olmayan eklenti hiç çalıştırılmaz.

const RULES_KEY = 'peel.rules';
const TRUST_KEY = 'peel.trustedKeys';
const read = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* depolama kapalı */ } };

export function createExtensionState() {
  let rulesText = read(RULES_KEY, '');
  let rulesOn = Boolean(rulesText.trim());
  const loaded = []; // { manifest, plugin, publicKey, enabled }
  return {
    get rulesText() { return rulesText; },
    setRulesText(v) { rulesText = v; rulesOn = Boolean(v.trim()); write(RULES_KEY, v); },
    get rulesOn() { return rulesOn; },
    setRulesOn(v) { rulesOn = v; },
    loaded,
    plugins() {
      const out = loaded.filter((p) => p.enabled).map((p) => p.plugin);
      if (rulesOn && rulesText.trim()) out.push(rulesPlugin(rulesText));
      return out;
    },
  };
}

export function renderExtend(root, ctx, state) {
  const area = h('textarea', { rows: 8, class: 'pi-input pi-mono', spellcheck: 'false' }, state.rulesText);
  const on = h('input', { type: 'checkbox', checked: state.rulesOn });
  const status = h('p', { class: 'pi-muted', role: 'status' });
  const validate = () => {
    try {
      const n = area.value.trim() ? parseRules(area.value).length : 0;
      status.className = 'pi-muted';
      status.textContent = tx(`${n} kural geçerli`, `${n} valid rules`);
      return true;
    } catch (e) {
      status.className = 'pi-err';
      status.textContent = e.message;
      return false;
    }
  };
  area.addEventListener('input', () => { if (validate()) state.setRulesText(area.value); });
  on.addEventListener('change', () => state.setRulesOn(on.checked));
  validate();

  const trust = h('textarea', { rows: 2, class: 'pi-input pi-mono', spellcheck: 'false', placeholder: tx('Güvenilen açık anahtarlar (base64, satır başına bir)', 'Trusted public keys (base64, one per line)') }, read(TRUST_KEY, ''));
  trust.addEventListener('input', () => write(TRUST_KEY, trust.value));
  const list = h('div', { class: 'pi-list' });
  const pout = h('div', { class: 'pi-out', 'aria-live': 'polite' });
  const drawList = () => list.replaceChildren(...state.loaded.map((p) => {
    const cb = h('input', { type: 'checkbox', checked: p.enabled });
    cb.addEventListener('change', () => { p.enabled = cb.checked; });
    return h('label', { class: 'pi-check' }, cb, `${p.manifest.id}@${p.manifest.version}`, h('span', { class: 'pi-muted' }, ` · ${p.manifest.author ?? ''} · ${p.fp}`));
  }));
  const add = h('button', { type: 'button', class: 'ghost' }, tx('İmzalı eklenti yükle (.peelplugin)', 'Load signed plugin (.peelplugin)'));
  add.addEventListener('click', () => busy(add, pout, async () => {
    const [f] = await pickFiles({ accept: '.peelplugin,application/json' });
    if (!f) return;
    const keys = trust.value.split(/\s+/).filter(Boolean);
    const v = await verifyPlugin(await readText(f), keys);
    const plugin = await importPluginSource(v.code);
    if (state.loaded.some((p) => p.manifest.id === v.manifest.id)) throw new Error(tx('Bu eklenti zaten yüklü', 'Plugin already loaded'));
    state.loaded.push({ manifest: v.manifest, plugin, publicKey: v.publicKey, fp: await fingerprint(v.publicKey), enabled: true });
    drawList();
    pout.replaceChildren(h('p', { class: 'pi-ok' }, tx(`${v.manifest.id} doğrulandı ve etkinleştirildi.`, `${v.manifest.id} verified and enabled.`)));
  }));
  drawList();

  root.replaceChildren(
    h('h4', {}, tx('Dönüşüm kuralları', 'Transformation rules')),
    h('p', { class: 'pi-muted' }, tx('Satır başına bir kural: ', 'One rule per line: '), h('code', {}, '@ad DESEN ==> YERİNE [when number($x)]'), tx('. $x herhangi bir ifade, $$x kalan argümanlar. Davranışı değiştiren kural derin modda geri alınır.', '. $x is any expression, $$x the remaining arguments. A rule that changes behaviour is rolled back in deep mode.')),
    area,
    h('div', { class: 'pi-row' }, h('label', { class: 'pi-check' }, on, tx('Bir sonraki çözmede uygula', 'Apply on next run')), status),
    h('h4', {}, tx('Eklentiler', 'Plugins')),
    h('p', { class: 'pi-muted' }, tx('Eklentiler Ed25519 ile imzalı olmalı ve imzalayan anahtar aşağıda listelenmeli. İmza kimin yazdığını kanıtlar, zararsızlığı değil: yalnızca güvendiğin kişilerin eklentilerini yükle.',
      'Plugins must be Ed25519-signed and the signing key listed below. A signature proves authorship, not safety: only load plugins from people you trust.')),
    field(tx('Güvenilen anahtarlar', 'Trusted keys'), trust),
    h('div', { class: 'pi-row' }, add), list, pout,
  );
}
