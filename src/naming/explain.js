import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';

// 80: satır satır açıklama modu. Her deyim için kuralla üretilmiş, deterministik bir cümle (TR/EN).

const MAX_LINES = 3000;
const short = (n, max = 40) => {
  let s;
  try { s = gen(n).replace(/\s+/g, ' '); } catch { s = n.type; }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const memberPath = (n) => {
  if (t.isIdentifier(n)) return n.name;
  if (t.isThisExpression(n)) return 'this';
  if (t.isMemberExpression(n)) {
    const k = !n.computed && t.isIdentifier(n.property) ? n.property.name : t.isStringLiteral(n.property) ? n.property.value : null;
    const o = memberPath(n.object);
    return o && k ? `${o}.${k}` : null;
  }
  return null;
};

// Bilinen API'lerin anlamı: [tr, en]; {0} ilk argüman
const API = [
  [/^document\.getElementById$/, ['sayfadan {0} kimlikli elemanı bulur', 'finds the element with id {0}']],
  [/\.querySelectorAll$/, ['{0} seçicisine uyan tüm elemanları bulur', 'finds all elements matching {0}']],
  [/\.querySelector$/, ['{0} seçicisine uyan ilk elemanı bulur', 'finds the first element matching {0}']],
  [/\.createElement$/, ['yeni bir <{0}> elemanı oluşturur', 'creates a new <{0}> element']],
  [/\.(appendChild|append)$/, ['elemanı sayfaya ekler', 'appends the element to the page']],
  [/\.addEventListener$/, ['{0} olayını dinlemeye başlar', 'starts listening for {0} events']],
  [/\.removeEventListener$/, ['{0} olay dinleyicisini kaldırır', 'removes the {0} listener']],
  [/\.setAttribute$/, ['{0} özniteliğini ayarlar', 'sets the {0} attribute']],
  [/^fetch$/, ['{0} adresine ağ isteği gönderir', 'sends a network request to {0}']],
  [/\.open$/, ['ağ isteğini hazırlar ({0})', 'prepares a network request ({0})']],
  [/\.send$/, ['ağ isteğini gönderir', 'sends the network request']],
  [/sendBeacon$/, ['arka planda veri gönderir', 'sends data in the background']],
  [/^(localStorage|sessionStorage)\.setItem$/, ['tarayıcı depolamasına {0} anahtarını yazar', 'writes key {0} to browser storage']],
  [/^(localStorage|sessionStorage)\.getItem$/, ['tarayıcı depolamasından {0} anahtarını okur', 'reads key {0} from browser storage']],
  [/^(localStorage|sessionStorage)\.removeItem$/, ['depolamadan {0} anahtarını siler', 'deletes key {0} from storage']],
  [/^JSON\.parse$/, ['JSON metnini nesneye çevirir', 'parses JSON text into an object']],
  [/^JSON\.stringify$/, ['nesneyi JSON metnine çevirir', 'serializes the object to JSON']],
  [/^atob$/, ['base64 metni çözer', 'decodes base64 text']],
  [/^btoa$/, ['metni base64 ile kodlar', 'encodes text as base64']],
  [/^String\.fromCharCode$/, ['karakter kodlarından metin üretir', 'builds text from character codes']],
  [/\.charCodeAt$/, ['karakterin sayısal kodunu alır', 'reads a character code']],
  [/^(setTimeout)$/, ['bir işi gecikmeli çalışmak üzere zamanlar', 'schedules work to run later']],
  [/^(setInterval)$/, ['bir işi düzenli aralıklarla tekrarlar', 'repeats work at an interval']],
  [/^clear(Timeout|Interval)$/, ['zamanlayıcıyı iptal eder', 'cancels a timer']],
  [/^console\.(log|info|warn|error|debug)$/, ['konsola yazar', 'writes to the console']],
  [/^Math\.random$/, ['rastgele sayı üretir', 'generates a random number']],
  [/^Math\.floor$/, ['sayıyı aşağı yuvarlar', 'rounds the number down']],
  [/^Date\.now$/, ['şimdiki zamanı (ms) alır', 'reads the current time (ms)']],
  [/^(parseInt|Number\.parseInt)$/, ['metni tam sayıya çevirir', 'parses text as an integer']],
  [/^(encodeURIComponent)$/, ['metni URL için kodlar', 'URL-encodes the text']],
  [/^(decodeURIComponent)$/, ['URL kodlamasını çözer', 'decodes URL encoding']],
  [/\.push$/, ['dizinin sonuna ekler', 'appends to the array']],
  [/\.(split)$/, ['metni {0} ile parçalara böler', 'splits the text by {0}']],
  [/\.(join)$/, ['dizi elemanlarını birleştirir', 'joins the array items']],
  [/\.(map)$/, ['her elemanı dönüştürür', 'transforms each item']],
  [/\.(forEach)$/, ['her eleman için işlem yapar', 'runs code for each item']],
  [/\.(filter)$/, ['koşula uyan elemanları seçer', 'selects matching items']],
  [/\.(then)$/, ['işlem bitince sonucu işler', 'handles the result when done']],
  [/\.(catch)$/, ['hata olursa yakalar', 'handles errors']],
  [/^(eval)$/, ['metni kod olarak çalıştırır', 'executes text as code']],
  [/^(crypto\.subtle\.\w+)$/, ['kriptografik işlem yapar', 'performs a cryptographic operation']],
  [/^(window\.)?location\.(assign|replace)$/, ['sayfayı {0} adresine yönlendirir', 'redirects the page to {0}']],
  [/^document\.write$/, ['sayfaya doğrudan HTML yazar', 'writes HTML directly into the page']],
];

const P = {
  tr: {
    decl: (k, n, v) => `${n} ${k === 'const' ? 'sabiti' : 'değişkeni'} tanımlanır${v ? `: ${v}` : ''}`,
    fn: (n, a) => `${n}(${a}) fonksiyonu tanımlanır`,
    cls: (n) => `${n} sınıfı tanımlanır`,
    call: (c, m) => `${c} çağrılır${m ? ` — ${m}` : ''}`,
    assign: (l, v) => `${l} değeri ${v} olarak ayarlanır`,
    compound: (l, op, v) => (op === '+=' ? `${l} değerine ${v} eklenir` : op === '-=' ? `${l} değerinden ${v} çıkarılır` : `${l} ${op} ${v} ile güncellenir`),
    update: (l, op) => `${l} bir ${op === '++' ? 'artırılır' : 'azaltılır'}`,
    ifs: (c) => `Koşul: ${c} doğruysa aşağıdaki blok çalışır`,
    elses: 'Aksi halde bu blok çalışır',
    loop: (c) => `Döngü: ${c} sürdükçe tekrarlanır`,
    forof: (x, y) => `${y} içindeki her ${x} için tekrarlanır`,
    forin: (x, y) => `${y} nesnesinin her ${x} anahtarı için tekrarlanır`,
    ret: (v) => (v ? `Fonksiyon ${v} değerini döndürür` : 'Fonksiyondan çıkılır'),
    thr: (v) => `Hata fırlatılır: ${v}`,
    tr: 'Hata yakalama bloğu başlar', ctch: (e) => `Hata olursa yakalanır${e ? ` (${e})` : ''}`, fin: 'Her durumda çalışacak blok',
    sw: (d) => `${d} değerine göre dallanır`, cs: (v) => (v ? `${v} durumunda:` : 'Hiçbiri uymazsa:'),
    brk: 'Döngü/switch bloğundan çıkılır', cont: 'Döngünün bir sonraki turuna geçilir',
    expr: (e) => `İfade hesaplanır: ${e}`,
    v: { str: (s) => `"${s}" metni`, num: (n) => `${n} sayısı`, bool: (b) => (b ? 'doğru' : 'yanlış'), nul: 'boş (null)', arr: (n) => `${n} elemanlı dizi`,
      obj: (n) => `${n} alanlı nesne`, fn: 'bir fonksiyon', call: (c) => `${c} çağrısının sonucu`, neu: (c) => `yeni bir ${c} nesnesi`,
      awaitv: (v) => `${v} (beklenerek)`, tmpl: 'şablon metin' },
  },
  en: {
    decl: (k, n, v) => `${k === 'const' ? 'Constant' : 'Variable'} ${n} is declared${v ? `: ${v}` : ''}`,
    fn: (n, a) => `Function ${n}(${a}) is defined`,
    cls: (n) => `Class ${n} is defined`,
    call: (c, m) => `${c} is called${m ? ` — ${m}` : ''}`,
    assign: (l, v) => `${l} is set to ${v}`,
    compound: (l, op, v) => (op === '+=' ? `${v} is added to ${l}` : op === '-=' ? `${v} is subtracted from ${l}` : `${l} is updated with ${op} ${v}`),
    update: (l, op) => `${l} is ${op === '++' ? 'incremented' : 'decremented'}`,
    ifs: (c) => `If ${c} holds, the block below runs`,
    elses: 'Otherwise this block runs',
    loop: (c) => `Loop: repeats while ${c}`,
    forof: (x, y) => `Repeats for each ${x} in ${y}`,
    forin: (x, y) => `Repeats for each key ${x} of ${y}`,
    ret: (v) => (v ? `The function returns ${v}` : 'Returns from the function'),
    thr: (v) => `Throws an error: ${v}`,
    tr: 'Error-handling block starts', ctch: (e) => `Errors are caught here${e ? ` (${e})` : ''}`, fin: 'Block that always runs',
    sw: (d) => `Branches on the value of ${d}`, cs: (v) => (v ? `When ${v}:` : 'When nothing matches:'),
    brk: 'Leaves the loop/switch', cont: 'Continues with the next iteration',
    expr: (e) => `Evaluates: ${e}`,
    v: { str: (s) => `the text "${s}"`, num: (n) => `the number ${n}`, bool: (b) => String(b), nul: 'null', arr: (n) => `an array of ${n}`,
      obj: (n) => `an object with ${n} fields`, fn: 'a function', call: (c) => `the result of ${c}`, neu: (c) => `a new ${c}`,
      awaitv: (v) => `${v} (awaited)`, tmpl: 'a template string' },
  },
};

// for (const x of …) başındaki hedef: bildirimse tanımlayıcısı
const loopTarget = (left) => short(t.isVariableDeclaration(left) ? left.declarations[0].id : left, 20);

function apiMeaning(call, L) {
  const name = memberPath(call.callee);
  if (!name) return null;
  const hit = API.find(([re]) => re.test(name));
  if (!hit) return null;
  const a0 = call.arguments[0];
  const arg = t.isStringLiteral(a0) ? `"${a0.value.slice(0, 30)}"` : a0 ? short(a0, 20) : '';
  return hit[1][L === 'en' ? 1 : 0].replace('{0}', arg);
}

function value(n, L) {
  const V = P[L].v;
  if (!n) return '';
  if (t.isStringLiteral(n)) return V.str(n.value.slice(0, 40));
  if (t.isNumericLiteral(n)) return V.num(n.value);
  if (t.isBooleanLiteral(n)) return V.bool(n.value);
  if (t.isNullLiteral(n)) return V.nul;
  if (t.isArrayExpression(n)) return V.arr(n.elements.length);
  if (t.isObjectExpression(n)) return V.obj(n.properties.length);
  if (t.isFunction(n)) return V.fn;
  if (t.isTemplateLiteral(n)) return V.tmpl;
  if (t.isAwaitExpression(n)) return V.awaitv(value(n.argument, L));
  if (t.isCallExpression(n)) {
    const m = apiMeaning(n, L);
    return `${V.call(short(n.callee, 30))}${m ? ` (${m})` : ''}`;
  }
  if (t.isNewExpression(n)) return V.neu(short(n.callee, 30));
  return short(n);
}

/** @returns {{ line: number, depth: number, text: string }[]} */
export function explain(ast, lang = 'tr') {
  const L = lang === 'en' ? 'en' : 'tr';
  const T = P[L];
  const out = [];
  const depthOf = (p) => {
    let d = 0;
    for (let x = p.parentPath; x; x = x.parentPath) if (x.isBlockStatement() || x.isSwitchCase()) d++;
    return d;
  };
  const push = (p, text) => {
    if (out.length < MAX_LINES && p.node.loc) out.push({ line: p.node.loc.start.line, depth: depthOf(p), text });
  };
  traverse(ast, {
    VariableDeclaration(p) {
      if (p.parentPath.isFor() || p.parentPath.isForXStatement()) return;
      const parts = p.node.declarations.map((d) => T.decl(p.node.kind, short(d.id, 30), d.init ? value(d.init, L) : ''));
      push(p, parts.join('; '));
    },
    FunctionDeclaration(p) { push(p, T.fn(p.node.id.name, p.node.params.map((x) => short(x, 15)).join(', '))); },
    ClassDeclaration(p) { push(p, T.cls(p.node.id?.name ?? '?')); },
    ExpressionStatement(p) {
      const e = p.node.expression;
      if (t.isCallExpression(e) || t.isNewExpression(e) || (t.isAwaitExpression(e) && t.isCallExpression(e.argument))) {
        const c = t.isAwaitExpression(e) ? e.argument : e;
        push(p, T.call(short(c.callee, 30), apiMeaning(c, L)));
      } else if (t.isAssignmentExpression(e) && e.operator !== '=') {
        push(p, T.compound(short(e.left, 30), e.operator, value(e.right, L)));
      } else if (t.isAssignmentExpression(e)) {
        push(p, T.assign(short(e.left, 30), value(e.right, L)));
      } else if (t.isUpdateExpression(e)) {
        push(p, T.update(short(e.argument, 30), e.operator));
      } else {
        push(p, T.expr(short(e, 50)));
      }
    },
    IfStatement(p) {
      push(p, T.ifs(short(p.node.test, 50)));
      if (p.node.alternate?.loc && !t.isIfStatement(p.node.alternate)) out.push({ line: p.node.alternate.loc.start.line, depth: depthOf(p), text: T.elses });
    },
    'WhileStatement|DoWhileStatement'(p) { push(p, T.loop(short(p.node.test, 50))); },
    ForStatement(p) { push(p, T.loop(p.node.test ? short(p.node.test, 50) : 'true')); },
    ForOfStatement(p) { push(p, T.forof(loopTarget(p.node.left), short(p.node.right, 30))); },
    ForInStatement(p) { push(p, T.forin(loopTarget(p.node.left), short(p.node.right, 30))); },
    ReturnStatement(p) { push(p, T.ret(p.node.argument ? value(p.node.argument, L) : '')); },
    ThrowStatement(p) { push(p, T.thr(short(p.node.argument, 50))); },
    TryStatement(p) {
      push(p, T.tr);
      const h = p.node.handler;
      if (h?.loc) out.push({ line: h.loc.start.line, depth: depthOf(p), text: T.ctch(h.param ? short(h.param, 20) : '') });
      if (p.node.finalizer?.loc) out.push({ line: p.node.finalizer.loc.start.line, depth: depthOf(p), text: T.fin });
    },
    SwitchStatement(p) { push(p, T.sw(short(p.node.discriminant, 40))); },
    SwitchCase(p) { push(p, T.cs(p.node.test ? short(p.node.test, 30) : '')); },
    BreakStatement(p) { push(p, T.brk); },
    ContinueStatement(p) { push(p, T.cont); },
  });
  // aynı satırda birden çok açıklama: birleştir
  const byLine = new Map();
  for (const e of out.sort((a, b) => a.line - b.line)) {
    const prev = byLine.get(e.line);
    if (prev) prev.text += `; ${e.text}`;
    else byLine.set(e.line, { ...e });
  }
  return [...byLine.values()];
}
