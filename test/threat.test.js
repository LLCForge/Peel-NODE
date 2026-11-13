// Tehdit modülü öz-denetimi: node test/threat.test.js
import assert from 'node:assert/strict';
import { classify, riskScore, maskSecrets, libraries, yaraRule, idsRules, missingGlobals } from '../src/core/threat.js';

const net = [{ api: 'fetch', url: 'https://evil.xyz/c', method: 'POST', body: 'x' }];
const skim = classify({ code: 'var c = document.querySelector("#cc_number").value; fetch(u, {method:"POST"})', runtime: { network: net }, iocs: {}, apis: [] });
assert.ok(skim.some((c) => c.id === 'magecart'), 'kart alanı + gönderim → magecart');
const benign = classify({ code: 'fetch("https://api.example.com", {method:"POST", body:"id=1"})', runtime: { network: net }, iocs: {}, apis: [] });
assert.ok(!benign.some((c) => c.id === 'skimmer'), 'yalnızca POST skimmer sayılmaz');
assert.equal(riskScore([], { network: [] }).level, 'none');
const m = maskSecrets('var k = "sk_live_abcdefghijklmnop1234"; var e = "a@b.com"; var j = "eyJhbGciOiJI.eyJzdWIiOiIx.c2lnbmF0dXJl";');
assert.equal(m.count, 3);
assert.ok(!m.code.includes('sk_live') && !m.code.includes('a@b.com') && !m.code.includes('eyJhbG'));
assert.deepEqual(libraries('/*! jQuery v3.7.1 */ jQuery.fn'), [{ name: 'jQuery', version: '3.7.1' }]);
assert.match(yaraRule({ strings: ['https://evil.xyz/collect', 'stealer-config'], iocs: {} }), /rule peel_sample[\s\S]*\$s0 = "https:\/\/evil\.xyz\/collect"/);
assert.match(idsRules({ runtime: { network: net }, iocs: {} }), /dns\.query; content:"evil\.xyz"/);
assert.deepEqual(missingGlobals({ thrown: ["ReferenceError: 'foo' is not defined"] }), ['foo']);
console.log('threat: ok');
