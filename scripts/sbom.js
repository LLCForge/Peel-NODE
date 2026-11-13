#!/usr/bin/env node
// I189: SBOM üretimi — package-lock.json'dan CycloneDX 1.5 JSON. Kullanım: node scripts/sbom.js [-o sbom.json] [--prod]
// Ağ kullanmaz; sürümler, lisanslar ve kilit dosyasındaki bütünlük özetleri (integrity) olduğu gibi aktarılır.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const purl = (name, version) => `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${version}`;

// SRI ("sha512-<base64>") → CycloneDX hash { alg, content(hex) }
function hashOf(integrity) {
  const m = /^(sha512|sha384|sha256|sha1)-(.+)$/.exec(integrity ?? '');
  if (!m) return [];
  const alg = { sha512: 'SHA-512', sha384: 'SHA-384', sha256: 'SHA-256', sha1: 'SHA-1' }[m[1]];
  return [{ alg, content: Buffer.from(m[2], 'base64').toString('hex') }];
}

export function buildSbom(lock, { prodOnly = false, timestamp = new Date().toISOString() } = {}) {
  const root = lock.packages?.[''] ?? {};
  const components = [];
  const seen = new Set();
  for (const [path, p] of Object.entries(lock.packages ?? {})) {
    if (!path || !p.version) continue;
    if (prodOnly && p.dev) continue;
    const name = p.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const ref = purl(name, p.version);
    if (seen.has(ref)) continue;
    seen.add(ref);
    components.push({
      type: 'library',
      'bom-ref': ref,
      name,
      version: p.version,
      purl: ref,
      scope: p.dev ? 'excluded' : p.optional ? 'optional' : 'required',
      ...(p.license ? { licenses: [{ license: { id: String(p.license) } }] } : {}),
      hashes: hashOf(p.integrity),
      ...(p.resolved ? { externalReferences: [{ type: 'distribution', url: p.resolved }] } : {}),
    });
  }
  components.sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref']));
  const rootRef = purl(root.name ?? lock.name, root.version ?? lock.version);
  const direct = Object.keys({ ...root.dependencies, ...root.optionalDependencies, ...(prodOnly ? {} : root.devDependencies) });
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      timestamp,
      tools: [{ vendor: 'PEEL', name: 'scripts/sbom.js' }],
      component: { type: 'application', 'bom-ref': rootRef, name: root.name ?? lock.name, version: root.version ?? lock.version, licenses: root.license ? [{ license: { id: root.license } }] : [] },
    },
    components,
    dependencies: [{ ref: rootRef, dependsOn: components.filter((c) => direct.includes(c.name)).map((c) => c['bom-ref']) }],
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const out = args.includes('-o') ? args[args.indexOf('-o') + 1] : null;
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const json = JSON.stringify(buildSbom(lock, { prodOnly: args.includes('--prod') }), null, 2);
  if (out) writeFileSync(out, json);
  else process.stdout.write(json);
}
