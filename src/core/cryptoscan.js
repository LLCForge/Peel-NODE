// Kripto taraması (E611–E616, E75–E79, E77): koddaki şifre/hash sabitleri, anahtar/IV/tuz/mod/dolgu
// tespiti ve anahtar koddan (ya da sandbox kayıtlarından) çıkarılabiliyorsa gömülü şifreli verinin çözümü.
// Kod değiştirilmez; sonuçlar rapora gider.
import * as t from '@babel/types';
import { parse } from './parse.js';
import { traverse } from '../util/ast.js';
import { AES_SBOX, AES_INV_SBOX } from '../crypto/aes.js';
import { DES_SBOXES } from '../crypto/des.js';
import { blowfishInit } from '../crypto/blowfish.js';
import { MD5_T } from '../crypto/stream.js';
import { CRC32_TABLE } from '../compress/inflate.js';
import { decrypt, decryptPassphrase, bruteDecrypt, plainText, utf8, latin1, hexBytes, b64Bytes, openSslSalted } from '../crypto/index.js';
import { completeKey, rsaDecrypt, parsePemKeys, toBig } from '../crypto/rsa.js';
import { ecbRepeats } from './stats.js';

// --- E611 / E612: sabit imzaları ---
const BF = blowfishInit();
const SIGNATURES = [
  { name: 'AES S-box', kind: 'cipher', seq: Array.from(AES_SBOX.subarray(0, 16)) },
  { name: 'AES ters S-box', kind: 'cipher', seq: Array.from(AES_INV_SBOX.subarray(0, 16)) },
  { name: 'AES Rcon', kind: 'cipher', seq: [1, 2, 4, 8, 16, 32, 64, 128, 27, 54] },
  { name: 'AES T-tablosu', kind: 'cipher', words: [0xc66363a5, 0xf87c7c84, 0xa5c66363, 0x6363a5c6], min: 1 },
  { name: 'DES S-kutusu', kind: 'cipher', seq: DES_SBOXES[0].slice(0, 16) },
  { name: 'DES permütasyonu (IP)', kind: 'cipher', seq: [58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36] },
  { name: 'Blowfish P-dizisi (pi)', kind: 'cipher', words: [BF[0], BF[1], BF[2], BF[3]], min: 2 },
  { name: 'Blowfish S-kutusu', kind: 'cipher', words: [BF[18], BF[19], BF[20]], min: 2 },
  { name: 'TEA/XTEA/XXTEA delta', kind: 'cipher', words: [0x9e3779b9], min: 1 },
  { name: 'ChaCha20/Salsa20 sabiti', kind: 'cipher', words: [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574], min: 2, text: /expand 32-byte k|expand 16-byte k/ },
  { name: 'RC4 anahtar planlama', kind: 'cipher', code: /for\s*\([^;]*;\s*\w+\s*<\s*(256|0x100)\s*;[\s\S]{0,200}?%\s*(256|0x100)/ },
  { name: 'MD5', kind: 'hash', words: [MD5_T[0], MD5_T[1], MD5_T[2], MD5_T[63]], min: 2 },
  { name: 'MD5/SHA-1 başlangıç değeri', kind: 'hash', words: [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476], min: 3 },
  { name: 'SHA-1', kind: 'hash', words: [0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6, 0xc3d2e1f0], min: 2 },
  { name: 'SHA-256', kind: 'hash', words: [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x6a09e667, 0xbb67ae85], min: 2 },
  { name: 'SHA-224', kind: 'hash', words: [0xc1059ed8, 0x367cd507, 0x3070dd17], min: 2 },
  { name: 'SHA-512', kind: 'hash', words: [0xd728ae22, 0x23ef65cd, 0xf3bcc908, 0x84caa73b], min: 2, big: [0x428a2f98d728ae22n, 0x6a09e667f3bcc908n] },
  { name: 'RIPEMD-160', kind: 'hash', words: [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0xa953fd4e], min: 2 },
  { name: 'MurmurHash3', kind: 'hash', words: [0xcc9e2d51, 0x1b873593, 0x85ebca6b, 0xc2b2ae35], min: 2 },
  { name: 'xxHash32', kind: 'hash', words: [0x9e3779b1, 0x85ebca77, 0xc2b2ae3d, 0x27d4eb2f], min: 2 },
  { name: 'FNV-1a', kind: 'hash', words: [0x811c9dc5, 16777619], min: 2 },
  { name: 'CRC32', kind: 'checksum', words: [0xedb88320, CRC32_TABLE[1], CRC32_TABLE[2]], min: 1 },
];

function collectNumbers(ast) {
  const words = new Set();
  const bigs = new Set();
  const arrays = [];
  traverse(ast, {
    NumericLiteral(p) {
      const v = p.node.value;
      if (Number.isInteger(v) && Math.abs(v) <= 0xffffffff) {
        const neg = p.parentPath.isUnaryExpression({ operator: '-' });
        words.add((neg ? -v : v) >>> 0);
      }
    },
    BigIntLiteral(p) { try { bigs.add(BigInt(p.node.value)); } catch { /* geçersiz */ } },
    ArrayExpression(p) {
      const els = p.node.elements;
      if (els.length >= 8 && els.every((e) => t.isNumericLiteral(e))) arrays.push(els.map((e) => e.value));
    },
  });
  return { words, bigs, arrays };
}

const hasSeq = (arrays, seq) => arrays.some((a) => {
  for (let i = 0; i + seq.length <= a.length; i++) if (seq.every((v, j) => a[i + j] === v)) return true;
  return false;
});

export function cryptoConstants(code, ast = null) {
  let tree = ast;
  if (!tree) { try { tree = parse(code); } catch { return []; } }
  const { words, bigs, arrays } = collectNumbers(tree);
  const out = [];
  for (const sig of SIGNATURES) {
    const evidence = [];
    if (sig.seq && hasSeq(arrays, sig.seq)) evidence.push(`tablo ${sig.seq.slice(0, 4).map((v) => `0x${v.toString(16)}`).join(', ')}…`);
    if (sig.words) {
      const hit = sig.words.filter((w) => words.has(w >>> 0));
      if (hit.length >= (sig.min ?? 1)) evidence.push(hit.map((w) => `0x${(w >>> 0).toString(16)}`).join(', '));
    }
    if (sig.big && sig.big.some((b) => bigs.has(b))) evidence.push('64 bit BigInt sabiti');
    if (sig.text && sig.text.test(code)) evidence.push('sabit string');
    if (sig.code && sig.code.test(code)) evidence.push('kod kalıbı');
    if (evidence.length) out.push({ name: sig.name, kind: sig.kind, evidence });
  }
  return out;
}

// --- değer çözümleme: AST ifadesinden bayt dizisi / string ---
const ENCODERS = { Utf8: utf8, Latin1: latin1, Hex: hexBytes, Base64: b64Bytes, Base64url: b64Bytes };

function memberPath(n) {
  if (t.isIdentifier(n)) return n.name;
  if (t.isMemberExpression(n)) {
    // kök çağrı ya da ifade olabilir (require("crypto").createDecipheriv): '*' ile temsil edilir
    const obj = memberPath(n.object) ?? '*';
    const prop = !n.computed && t.isIdentifier(n.property) ? n.property.name : t.isStringLiteral(n.property) ? n.property.value : null;
    return obj && prop ? `${obj}.${prop}` : null;
  }
  return null;
}

function resolve(node, scope, depth = 0) {
  if (!node || depth > 4) return null;
  if (t.isStringLiteral(node)) return { str: node.value };
  if (t.isTemplateLiteral(node) && !node.expressions.length) return { str: node.quasis[0].value.cooked };
  if (t.isIdentifier(node) && scope) {
    const b = scope.getBinding(node.name);
    if (b && b.constant && t.isVariableDeclarator(b.path.node) && b.path.node.init) return resolve(b.path.node.init, b.path.scope, depth + 1);
    return null;
  }
  if (t.isArrayExpression(node) && node.elements.length && node.elements.every((e) => t.isNumericLiteral(e) && e.value >= 0 && e.value < 256)) {
    return { bytes: Uint8Array.from(node.elements.map((e) => e.value)) };
  }
  if (t.isBinaryExpression(node, { operator: '+' })) {
    const a = resolve(node.left, scope, depth + 1);
    const b = resolve(node.right, scope, depth + 1);
    if (a?.str != null && b?.str != null) return { str: a.str + b.str };
  }
  if (t.isNewExpression(node) || t.isCallExpression(node)) {
    const callee = memberPath(node.callee) ?? '';
    const args = node.arguments;
    // CryptoJS.enc.Hex.parse("..") / X.enc.Utf8.parse(..)
    const enc = callee.match(/\.enc\.(Utf8|Latin1|Hex|Base64|Base64url)\.parse$/);
    if (enc) {
      const v = resolve(args[0], scope, depth + 1);
      const bytes = v?.str != null ? ENCODERS[enc[1]](v.str) : null;
      return bytes ? { bytes, how: `enc.${enc[1]}` } : null;
    }
    // Buffer.from("..", "hex"|"base64"|"utf8")
    if (/(^|\.)Buffer\.from$/.test(callee)) {
      const v = resolve(args[0], scope, depth + 1);
      if (v?.bytes) return v;
      const e = args[1] && t.isStringLiteral(args[1]) ? args[1].value.toLowerCase() : 'utf8';
      if (v?.str == null) return null;
      const bytes = e === 'hex' ? hexBytes(v.str) : e === 'base64' ? b64Bytes(v.str) : e === 'latin1' || e === 'binary' ? latin1(v.str) : utf8(v.str);
      return bytes ? { bytes } : null;
    }
    // new Uint8Array([..]) / Uint8Array.from([..])
    if (/^(Uint8Array|Uint8Array\.from)$/.test(callee)) {
      const v = resolve(args[0], scope, depth + 1);
      return v?.bytes ? v : null;
    }
    // new TextEncoder().encode("..")
    if (t.isMemberExpression(node.callee) && /encode$/.test(callee) && t.isNewExpression(node.callee.object) &&
        t.isIdentifier(node.callee.object.callee, { name: 'TextEncoder' })) {
      const v = resolve(args[0], scope, depth + 1);
      return v?.str != null ? { bytes: utf8(v.str) } : null;
    }
    // atob("..") → latin1 bayt
    if (callee === 'atob') {
      const v = resolve(args[0], scope, depth + 1);
      const bytes = v?.str != null ? b64Bytes(v.str) : null;
      return bytes ? { bytes } : null;
    }
  }
  return null;
}

const asBytes = (v) => (!v ? null : v.bytes ?? (v.str != null ? utf8(v.str) : null));
// Şifreli veri: string ise base64 (CryptoJS varsayılanı) ya da hex
const cipherBytes = (v) => (!v ? null : v.bytes ?? (v.str != null ? (b64Bytes(v.str) ?? hexBytes(v.str)) : null));
const show = (v) => (!v ? null : v.str != null ? v.str : Array.from(v.bytes).map((b) => b.toString(16).padStart(2, '0')).join(''));

const CRYPTOJS_ALG = { AES: 'AES', DES: 'DES', TripleDES: '3DES', RC4: 'RC4', RC4Drop: 'RC4Drop', Blowfish: 'Blowfish' };
const MODE_NAMES = ['CBC', 'ECB', 'CTR', 'CFB', 'OFB', 'GCM'];
const PAD_MAP = { Pkcs7: 'pkcs7', NoPadding: 'none', ZeroPadding: 'zero', AnsiX923: 'ansix923', Iso10126: 'pkcs7', Iso97971: 'iso7816' };

function objectProps(node, scope) {
  const out = {};
  if (!t.isObjectExpression(node)) return out;
  for (const p of node.properties) {
    if (!t.isObjectProperty(p)) continue;
    const k = t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : null;
    if (!k) continue;
    out[k] = { node: p.value, path: memberPath(p.value), value: resolve(p.value, scope) };
  }
  return out;
}

// Algoritma adı: "aes-256-cbc", "AES-CBC", {name:"AES-CTR"}
function parseAlgName(s) {
  const m = String(s).toUpperCase().match(/(AES|DES-EDE3|DES-EDE|3DES|TRIPLEDES|DES|BF|BLOWFISH|RC4|XXTEA|XTEA|TEA)(?:-(\d+))?(?:-(CBC|ECB|CTR|CFB|OFB|GCM))?/);
  if (!m) return null;
  const alg = { 'DES-EDE3': '3DES', 'DES-EDE': '3DES', TRIPLEDES: '3DES', BF: 'Blowfish', BLOWFISH: 'Blowfish' }[m[1]] ?? m[1];
  return { alg, mode: m[3] ?? null };
}

/** Koddaki kripto çağrılarını, anahtar/IV/tuz/mod/dolgu bilgileriyle birlikte toplar. */
export function cryptoCalls(ast) {
  const calls = [];
  const keys = [];
  traverse(ast, {
    CallExpression(p) {
      const callee = memberPath(p.node.callee) ?? '';
      const args = p.node.arguments;
      const scope = p.scope;
      // CryptoJS: X.AES.decrypt(data, key, cfg) / encrypt
      const cj = callee.match(/(?:^|\.)(AES|DES|TripleDES|RC4|RC4Drop|Blowfish)\.(decrypt|encrypt)$/);
      if (cj) {
        const cfg = objectProps(args[2], scope);
        const mode = cfg.mode?.path?.match(/\.mode\.(\w+)$/)?.[1] ?? (cj[1].startsWith('RC4') ? null : 'CBC');
        const pad = cfg.padding?.path?.match(/\.pad\.(\w+)$/)?.[1];
        const key = resolve(args[1], scope);
        calls.push({
          api: `CryptoJS.${cj[1]}.${cj[2]}`, op: cj[2], alg: CRYPTOJS_ALG[cj[1]], mode,
          padding: pad ? PAD_MAP[pad] ?? pad : null, data: resolve(args[0], scope), key,
          // string anahtar CryptoJS'te paroladır (EVP_BytesToKey); WordArray anahtar doğrudan anahtardır
          passphrase: key?.str != null, iv: cfg.iv?.value ?? null, salt: cfg.salt?.value ?? null,
        });
        return;
      }
      // CryptoJS.PBKDF2(parola, tuz, { keySize, iterations })
      const kdf = callee.match(/(?:^|\.)(PBKDF2|EvpKDF)$/);
      if (kdf) {
        const cfg = objectProps(args[2], scope);
        calls.push({ api: `CryptoJS.${kdf[1]}`, op: 'kdf', key: resolve(args[0], scope), salt: resolve(args[1], scope),
          iterations: cfg.iterations?.value?.str ?? (t.isNumericLiteral(cfg.iterations?.node) ? cfg.iterations.node.value : null) });
        return;
      }
      // Node crypto: createDecipheriv("aes-256-cbc", key, iv)
      const nd = callee.match(/(?:^|\.)create(Decipheriv|Cipheriv|Decipher|Cipher)$/);
      if (nd) {
        const name = resolve(args[0], scope)?.str;
        const parsed = name ? parseAlgName(name) : null;
        calls.push({ api: callee, op: /Decipher/.test(nd[1]) ? 'decrypt' : 'encrypt', alg: parsed?.alg ?? name ?? null, mode: parsed?.mode ?? null,
          key: resolve(args[1], scope), iv: resolve(args[2], scope), passphrase: !/iv$/.test(nd[1]) });
        return;
      }
      // forge.cipher.createDecipher("AES-CBC", key)
      const fg = callee.match(/(?:^|\.)cipher\.create(Decipher|Cipher)$/);
      if (fg) {
        const parsed = parseAlgName(resolve(args[0], scope)?.str ?? '');
        calls.push({ api: callee, op: fg[1] === 'Decipher' ? 'decrypt' : 'encrypt', alg: parsed?.alg ?? null, mode: parsed?.mode ?? null, key: resolve(args[1], scope) });
        return;
      }
      // WebCrypto: subtle.importKey("raw", keyData, alg, …) ve subtle.decrypt({ name, iv }, key, data)
      if (/(?:^|\.)subtle\.importKey$/.test(callee)) {
        const fmt = resolve(args[0], scope)?.str;
        const alg = t.isObjectExpression(args[2]) ? objectProps(args[2], scope).name?.value?.str : resolve(args[2], scope)?.str;
        const k = resolve(args[1], scope);
        calls.push({ api: 'crypto.subtle.importKey', op: 'importKey', alg: alg ? parseAlgName(alg)?.alg ?? alg : null, mode: alg ? parseAlgName(alg)?.mode : null, key: fmt === 'raw' ? k : null });
        return;
      }
      if (/(?:^|\.)subtle\.(decrypt|encrypt)$/.test(callee)) {
        const cfg = objectProps(args[0], scope);
        const name = cfg.name?.value?.str ?? resolve(args[0], scope)?.str;
        const parsed = name ? parseAlgName(name) : null;
        calls.push({ api: callee, op: callee.endsWith('decrypt') ? 'decrypt' : 'encrypt', alg: parsed?.alg ?? name ?? null, mode: parsed?.mode ?? null,
          iv: cfg.iv?.value ?? cfg.counter?.value ?? null, data: resolve(args[2], scope), keyRef: t.isIdentifier(args[1]) ? args[1].name : null });
        return;
      }
      // XXTEA kütüphaneleri: XXTEA.decrypt(data, key) / xxtea.decryptToString(data, key)
      const xx = callee.match(/(?:^|\.)(xxtea|XXTEA)\.(decrypt|decryptToString|encrypt)$/i);
      if (xx) {
        calls.push({ api: callee, op: xx[2].startsWith('decrypt') ? 'decrypt' : 'encrypt', alg: 'XXTEA', data: resolve(args[0], scope), key: resolve(args[1], scope) });
        return;
      }
      // JSEncrypt: x.setPrivateKey(pem)
      if (/\.set(Private|Public)Key$/.test(callee)) {
        const v = resolve(args[0], scope);
        if (v?.str) keys.push({ label: callee.split('.').pop(), value: v.str, rsa: true });
      }
    },
    // isimden anahtar/IV/tuz adayları: var key = "..."; { iv: "..." }
    'VariableDeclarator|ObjectProperty|AssignmentExpression'(p) {
      const n = p.node;
      const nameNode = t.isVariableDeclarator(n) ? n.id : t.isObjectProperty(n) ? n.key : n.left;
      const valueNode = t.isVariableDeclarator(n) ? n.init : t.isObjectProperty(n) ? n.value : n.right;
      const name = t.isIdentifier(nameNode) ? nameNode.name : t.isStringLiteral(nameNode) ? nameNode.value : t.isMemberExpression(nameNode) ? memberPath(nameNode) : null;
      if (!name || !valueNode) return;
      const role = /(^|[._])(iv|nonce|counter)$/i.test(name) ? 'iv' : /salt/i.test(name) ? 'salt' : /(key|secret|pass(word|phrase)?|pwd)$/i.test(name) ? 'key' : null;
      if (!role) return;
      const v = resolve(valueNode, p.scope);
      if (v && (v.str == null || (v.str.length >= 4 && v.str.length <= 512))) keys.push({ label: name, role, value: show(v), resolved: v });
    },
  });
  return { calls, keys };
}

// --- E77: RSA parçaları ---
function rsaFromCode(strings, numbers) {
  const keys = parsePemKeys(strings.join('\n'), b64Bytes);
  // isimli büyük sayılar: n/modulus, e/exponent, d, p, q (hex ya da onluk string, BigInt)
  const parts = {};
  for (const [name, v] of numbers) {
    const role = /^(n|modulus)$/i.test(name) ? 'n' : /^(e|exponent|publicExponent)$/i.test(name) ? 'e' : /^(d|privateExponent)$/i.test(name) ? 'd' : /^(p|prime1)$/i.test(name) ? 'p' : /^(q|prime2)$/i.test(name) ? 'q' : null;
    if (role) parts[role] = v;
  }
  if (parts.n || (parts.p && parts.q)) keys.push({ ...parts, e: parts.e ?? 65537n, source: 'sayı parçaları' });
  return keys;
}

function namedNumbers(ast) {
  const out = [];
  traverse(ast, {
    'VariableDeclarator|ObjectProperty'(p) {
      const n = p.node;
      const id = t.isVariableDeclarator(n) ? n.id : n.key;
      const val = t.isVariableDeclarator(n) ? n.init : n.value;
      const name = t.isIdentifier(id) ? id.name : t.isStringLiteral(id) ? id.value : null;
      if (!name || !val) return;
      let v = null;
      if (t.isBigIntLiteral(val)) v = BigInt(val.value);
      else if (t.isNumericLiteral(val) && Number.isSafeInteger(val.value)) v = BigInt(val.value);
      else if (t.isStringLiteral(val)) {
        const s = val.value.replace(/[\s:]/g, '');
        if (/^\d{2,}$/.test(s) && s.length < 2000) v = BigInt(s);
        else if (/^(0x)?[0-9a-f]{2,}$/i.test(s) && s.length < 2000) v = BigInt(s.startsWith('0x') ? s : `0x${s}`);
      }
      if (v !== null && v > 1n) out.push([name, v]);
    },
  });
  return out;
}

// --- ana giriş ---
const MAX_BLOBS = 25;
const MAX_KEYS = 30;

/**
 * @param {object} o
 * @param {string} o.code     çözülmüş kod
 * @param {string[]} o.strings çıktıdaki string literal'ler
 * @param {Array} o.runtime   sandbox kripto kayıtları (runtime.crypto)
 */
export function cryptoScan({ code, strings = [], runtimeCrypto = [] }) {
  let ast;
  try { ast = parse(code); } catch { return { constants: [], calls: [], keys: [], decrypted: [], rsa: [], modes: [], paddings: [], salts: [] }; }
  const constants = cryptoConstants(code, ast);
  const { calls, keys } = cryptoCalls(ast);
  const decrypted = [];
  const seen = new Set();
  const record = (r) => {
    const k = `${r.alg}|${r.text}`;
    if (seen.has(k)) return;
    seen.add(k);
    decrypted.push(r);
  };

  // 1) Tam belirli çağrılar: algoritma, anahtar ve veri koddan çıkıyor
  for (const c of calls.filter((x) => x.op === 'decrypt' && x.data && (x.key || x.keyRef))) {
    let key = c.key;
    if (!key && c.keyRef) key = calls.find((k) => k.op === 'importKey' && k.key)?.key ?? null;
    const data = cipherBytes(c.data);
    if (!key || !data) continue;
    if (c.passphrase && openSslSalted(data)) {
      const r = decryptPassphrase({ alg: c.alg, mode: c.mode ?? 'CBC', passphrase: asBytes(key), data });
      const text = r && plainText(r.plain);
      if (text) record({ source: c.api, alg: c.alg, mode: c.mode ?? 'CBC', key: show(key), iv: 'EVP_BytesToKey', padding: r.padding, salt: show({ bytes: r.salt }), text });
      continue;
    }
    if (c.alg === 'AES' && c.mode === 'GCM') continue; // GCM: kimlik doğrulamalı mod, etiket olmadan çözülmez
    const r = decrypt({ alg: c.alg, mode: c.mode ?? 'CBC', key: asBytes(key), iv: asBytes(c.iv), data, padding: c.padding ?? 'auto' });
    const text = r && plainText(r.plain);
    if (text) record({ source: c.api, alg: c.alg, mode: c.mode ?? null, key: show(key), iv: show(c.iv), padding: r.padding, text });
  }

  // 2) Genel deneme: koddaki şifreli veri adayları × anahtar adayları (koddan + sandbox importKey kayıtlarından)
  const blobs = [];
  for (const s of strings) {
    if (s.length < 16 || s.length > 8192) continue;
    const b = /^[0-9a-f]+$/i.test(s) ? hexBytes(s) : b64Bytes(s);
    if (b && b.length >= 8 && !plainText(b)) blobs.push({ s, b });
    if (blobs.length >= MAX_BLOBS) break;
  }
  const keyCands = [];
  const ivCands = [];
  const pushKey = (bytes, label, list = keyCands) => {
    if (bytes && bytes.length >= 4 && bytes.length <= 72 && !list.some((k) => k.label === label)) list.push({ bytes, label });
  };
  for (const k of keys) {
    const b = k.resolved?.bytes ?? (k.resolved?.str != null ? utf8(k.resolved.str) : null);
    if (k.role === 'iv') pushKey(b, k.label, ivCands);
    else if (k.role === 'key' || k.role === 'salt') pushKey(b, k.label);
  }
  for (const c of calls) {
    if (c.key) pushKey(asBytes(c.key), `${c.api}: ${show(c.key)}`);
    if (c.iv) pushKey(asBytes(c.iv), `${c.api} iv`, ivCands);
  }
  for (const r of runtimeCrypto) {
    if (r.op === 'importKey' && /^[0-9a-f]+$/.test(r.data ?? '')) pushKey(hexBytes(r.data), `sandbox importKey ${r.alg}`);
  }
  // anahtar adında olmayan kısa string'ler de denenir (gizlenmiş kodda değişken adları anlamsız)
  for (const s of strings) {
    if (keyCands.length >= MAX_KEYS) break;
    if ([8, 16, 24, 32].includes(s.length) && /^[\x21-\x7e]+$/.test(s)) pushKey(utf8(s), s);
  }
  for (const { s, b } of blobs) {
    if (decrypted.some((d) => d.blob === s)) continue;
    for (const hit of bruteDecrypt(b, keyCands, ivCands, { limit: 1500 }).slice(0, 1)) {
      record({ source: 'kaba deneme', blob: s.slice(0, 60), ...hit });
    }
  }

  // 3) E77: RSA
  const rsa = [];
  const rsaKeys = rsaFromCode([...strings, ...keys.filter((k) => k.rsa).map((k) => k.value)], namedNumbers(ast));
  for (const raw of rsaKeys) {
    const key = completeKey(raw);
    const entry = { source: raw.source, bits: raw.n ? raw.n.toString(2).length : null, private: Boolean(raw.d), recovered: key ? key.how : null, decrypted: [] };
    if (key) {
      const k = Math.ceil(key.n.toString(16).length / 2);
      for (const s of strings) {
        // hex string base64 alfabesine de uyar: modül uzunluğunu tutan çözüm seçilir
        const b = [hexBytes(s), b64Bytes(s)].find((x) => x && x.length <= k && x.length >= k - 1);
        if (!b || toBig(b) >= key.n) continue;
        const r = rsaDecrypt(key, b);
        const text = r && plainText(r.data);
        if (text) entry.decrypted.push({ cipher: s.slice(0, 40), padding: r.padding, text });
        if (entry.decrypted.length >= 10) break;
      }
    }
    rsa.push(entry);
  }

  // E614: tuz / IV; E615: mod; E616: dolgu
  const salts = [
    ...strings.filter((s) => /^U2FsdGVkX1/.test(s)).map((s) => ({ kind: 'OpenSSL Salted__', value: s.slice(0, 40), salt: show({ bytes: b64Bytes(s)?.subarray(8, 16) ?? new Uint8Array(0) }) })),
    ...keys.filter((k) => k.role === 'salt').map((k) => ({ kind: 'isimli tuz', value: k.label, salt: k.value })),
    ...calls.filter((c) => c.op === 'kdf').map((c) => ({ kind: c.api, value: show(c.key) ?? '?', salt: show(c.salt) ?? '?', iterations: c.iterations ?? null })),
  ];
  const ivs = [...keys.filter((k) => k.role === 'iv').map((k) => ({ name: k.label, value: k.value })),
    ...calls.filter((c) => c.iv).map((c) => ({ name: `${c.api} iv`, value: show(c.iv) }))];
  const modes = new Map();
  for (const c of calls) if (c.mode) modes.set(`${c.alg}-${c.mode}`, c.api);
  for (const s of strings) {
    const m = parseAlgName(s);
    if (m?.mode && /^[\w-]{6,24}$/.test(s)) modes.set(`${m.alg}-${m.mode}`, `string "${s}"`);
  }
  for (const { s, b } of blobs) {
    const e = ecbRepeats(b, 16);
    if (e.ecbLikely) modes.set('ECB (tekrar eden blok)', `${s.slice(0, 24)}… ${e.repeats} tekrar`);
  }
  const paddings = [...new Set([...calls.filter((c) => c.padding).map((c) => `${c.padding} (${c.api})`), ...decrypted.map((d) => `${d.padding} (çözümden)`)])];

  return {
    constants,
    calls: calls.map((c) => ({ api: c.api, op: c.op, alg: c.alg ?? null, mode: c.mode ?? null, key: show(c.key), iv: show(c.iv), padding: c.padding ?? null })),
    keys: keys.filter((k) => k.role === 'key').map((k) => ({ name: k.label, value: k.value })),
    ivs,
    salts,
    modes: [...modes].map(([mode, where]) => ({ mode, where })),
    paddings,
    decrypted,
    rsa,
  };
}
