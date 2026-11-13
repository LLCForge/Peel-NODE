import * as t from '@babel/types';

// Düğüm kimliğiyle bulunan anahtar yolu: kökten hedefe [anahtar, indeks|null] zinciri.
// Aynı yapıdaki bir kopyada (cloneNode) aynı yeri bulmak ve Babel path'leri bayatlamadan düzenlemek için.

export function keyPath(root, target) {
  const path = [];
  const find = (n) => {
    if (n === target) return true;
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          if (v[i] && typeof v[i] === 'object') { path.push([k, i]); if (find(v[i])) return true; path.pop(); }
        }
      } else if (v && typeof v === 'object') { path.push([k, null]); if (find(v)) return true; path.pop(); }
    }
    return false;
  };
  return find(root) ? path : null;
}

export function follow(root, kp) {
  let n = root;
  for (const [k, i] of kp) n = i === null ? n[k] : n[k][i];
  return n;
}

// Yoldaki deyimi deyim listesiyle değiştir (liste değilse blok içine al)
export function placeAt(root, kp, stmts) {
  const parent = follow(root, kp.slice(0, -1));
  const [k, idx] = kp[kp.length - 1];
  if (idx !== null && Array.isArray(parent[k])) parent[k].splice(idx, 1, ...stmts);
  else parent[k] = t.blockStatement(stmts);
}
