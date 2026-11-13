import { obfuscate } from './obfuscate.js';

// J192: CTF modu. Her görev, bayrağı (PEEL{...}) gizleyen küçük bir programdır; cihazda gerçek
// javascript-obfuscator ile sabit seed'le gizlenir, kullanıcı PEEL ile çözüp bayrağı bulur.
// Bayraklar burada SHA-256 özetiyle denetlenir. Kaynak açık olduğundan bu bir eğitim oyunudur,
// gizli bir yarışma değil. reveal: PEEL çıktısında görünmesi gereken ipucu (test/ctf.test.js denetler).

export const CHALLENGES = [
  {
    id: 'isinma',
    title: { tr: 'Isınma: string dizisi', en: 'Warm-up: string array' },
    difficulty: 1,
    preset: 'low',
    seed: 1101,
    hint: { tr: 'String\'ler bir diziye taşınmış. Çöz ve okunur hale gelen string\'lere bak.', en: 'Strings were moved into an array. Deobfuscate and look at the readable strings.' },
    source: `var secret = "PEEL{str1ng_4rr4y_g0n3}";
function show(h) { if (h === "#flag") console.log(secret); else console.log("nothing here"); }
show(typeof location === "undefined" ? "" : location.hash);`,
    reveal: ['PEEL{str1ng_4rr4y_g0n3}'],
    flagHash: '23c15cfac417c70bfd2649f16376bc4ad024bcb3ecb3490f746efa6cce450437',
  },
  {
    id: 'parcalar',
    title: { tr: 'Parçalar: base64 ve bölünmüş string', en: 'Pieces: base64 and split strings' },
    difficulty: 2,
    preset: 'medium',
    seed: 2202,
    hint: { tr: 'Bayrak parçalara bölünüp base64 ile saklandı. Karşılaştırma ifadesine bak.', en: 'The flag was split and stored as base64. Look at the comparison.' },
    source: `function check(input) { return input === "PEEL{" + "r0t4t3d_" + "b64}"; }
console.log(check("guess") ? "correct" : "wrong");`,
    reveal: ['r0t4t3d_'],
    flagHash: '0c41d9c8eb0fe02409a349bdda2d6ead9f4fee8827d0bbb4b56117dc827f074f',
  },
  {
    id: 'akis',
    title: { tr: 'Akış: düzleştirilmiş kontrol akışı', en: 'Flow: flattened control flow' },
    difficulty: 3,
    preset: 'high',
    seed: 3303,
    hint: { tr: 'Parçalar doğru sırayla birleşince bayrak çıkar; sırayı kontrol akışı belirler.', en: 'The pieces form the flag in the right order; control flow decides the order.' },
    source: `function build() {
  var parts = [];
  parts.push("PEEL{");
  parts.push("fl4tt3n");
  parts.push("3d_fl0w}");
  return parts;
}
var p = build();
console.log(p.length);`,
    reveal: ['fl4tt3n', '3d_fl0w}'],
    flagHash: '48085143d64a2938cc00ec4a77c66c6ea1a5373691786f231ac60cfce70f15d3',
  },
  {
    id: 'xor',
    title: { tr: 'XOR: elle hesapla', en: 'XOR: compute by hand' },
    difficulty: 4,
    preset: 'medium',
    seed: 4404,
    hint: { tr: 'PEEL sayı dizisini ve anahtarı açığa çıkarır; her sayıyı anahtarla XOR\'la.', en: 'PEEL reveals the number array and the key; XOR each number with the key.' },
    source: `var data = [71, 82, 82, 91, 108, 111, 39, 101, 72, 117, 110, 72, 127, 35, 121, 115, 106];
var key = 23;
function decode(d, k) { var out = ""; for (var i = 0; i < d.length; i++) out += String["fromCharCode"](d[i] ^ k); return out; }
if (Date.now() < 0) console.log(decode(data, key));
console.log("length", data.length);`,
    reveal: ['71, 82, 82, 91'],
    flagHash: '003ab3478e7280486740a1409d6d54ea43caf3f5264f6d6b1d39cc1e3c0c28db',
  },
  {
    id: 'maks',
    title: { tr: 'Maksimum: obfuscator.io en yüksek profil', en: 'Maximum: obfuscator.io highest profile' },
    difficulty: 5,
    preset: 'max',
    seed: 5505,
    hint: { tr: 'Bayrak yalnızca doğru parolayla dönüyor. Parolayı ve dönen değeri bul.', en: 'The flag is only returned for the right password. Find the password and the return value.' },
    source: `function unlock(pw) {
  if (pw === "peel-ctf") return "PEEL{m4x_pr3s3t_d0wn}";
  return "nope";
}
console.log(unlock("guess"));`,
    reveal: ['PEEL{m4x_pr3s3t_d0wn}'],
    flagHash: '230918069e0dc859ccb271f19ab98fa6c70cac08e9b9493b7b7bb2dd52ae7359',
  },
];

export const challengeById = (id) => CHALLENGES.find((c) => c.id === id) ?? null;

/** Görevin gizlenmiş kodu (aynı seed her seferinde aynı kodu verir). */
export async function buildChallenge(id) {
  const c = challengeById(id);
  if (!c) throw new Error(`Görev bulunamadı: ${id}`);
  return obfuscate(c.source, c.preset, { seed: c.seed });
}

async function sha256Hex(text) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function checkFlag(id, flag) {
  const c = challengeById(id);
  if (!c || typeof flag !== 'string' || flag.length > 200) return false;
  return (await sha256Hex(flag.trim())) === c.flagHash;
}
