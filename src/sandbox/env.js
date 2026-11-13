// Çalışma ortamı seçimi: 'browser' (Peel-JS tarayıcı stub'ları) ya da 'node' (src/sandbox/node-stubs.js).
// 'auto': koddaki Node işaretlerine bakılır. Seçilen ortam sandbox isteklerinin yapılandırmasına eklenir; böylece
// pass'ler, davranış doğrulaması ve rapor çalıştırmaları ortamı ayrıca bilmek zorunda kalmaz.

// require("x") / require('x') çağrısı (__webpack_require__ ya da a.require değil), process.<Node API>, Buffer kurucuları,
// __dirname/__filename, module.exports'a atama, node: önekli modül adı
const NODE_SIGNS = [
  /(?<![\w$.])require\s*\(\s*(['"`]|[\w$]+\s*\()/,
  /(?<![\w$.])process\s*\.\s*(env|argv|platform|exit|cwd|nextTick|versions|stdout|stderr|stdin|pid|on|execPath|arch|mainModule|binding)\b/,
  /(?<![\w$.])Buffer\s*\.\s*(from|alloc|allocUnsafe|concat|isBuffer|byteLength)\s*\(/,
  /(?<![\w$.])new\s+Buffer\s*\(/,
  /(?<![\w$.])__(dirname|filename)\b/,
  /['"]node:[a-z_/]+['"]/,
];
const MAX_SCAN = 2_000_000;
// kendi kaynağını okuyan kodlar için (fs.readFileSync(__filename)); bu sınırın üstünde yalnızca açık işaret varsa eklenir
const SOURCE_MAX = 512 * 1024;

export function detectEnv(code) {
  const s = String(code ?? '');
  const sample = s.length > MAX_SCAN ? s.slice(0, MAX_SCAN) : s;
  return NODE_SIGNS.some((re) => re.test(sample)) ? 'node' : 'browser';
}

export function resolveEnv(env, ...codes) {
  if (env === 'node' || env === 'browser') return env;
  return codes.some((c) => c && detectEnv(c) === 'node') ? 'node' : 'browser';
}

/**
 * Sandbox API'sini ortamla sarar: run/batch/open isteklerinin config'ine env (ve Node için kaynak) eklenir.
 * batchIn/evalIn/close açılmış bağlamı kullanır, değişmez. Tarayıcıda sandbox olduğu gibi döner.
 */
export function withEnv(sandbox, env, { source = null } = {}) {
  if (!sandbox || env !== 'node') return sandbox;
  if (sandbox.__peelEnv === 'node') return sandbox;
  const node = {};
  if (typeof source === 'string' && (source.length <= SOURCE_MAX || /__filename|readFile/.test(source))) node.source = source;
  const add = (o = {}) => {
    const config = o.config ?? {};
    return { ...o, config: { ...config, env: 'node', node: { ...node, ...(config.node ?? {}) } } };
  };
  return {
    ...sandbox,
    __peelEnv: 'node',
    run: (code, o) => sandbox.run(code, add(o)),
    batch: (list, o) => sandbox.batch(list, add(o)),
    open: (code, o) => sandbox.open(code, add(o)),
  };
}
