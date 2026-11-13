// JS değeri → AST düğümü. Primitive olmayan değerler için null döner.
export function literalOf(t, v) {
  if (v === null) return t.nullLiteral();
  if (v === undefined) return t.unaryExpression('void', t.numericLiteral(0));
  if (typeof v === 'boolean') return t.booleanLiteral(v);
  if (typeof v === 'string') return t.stringLiteral(v);
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return t.identifier('NaN');
    const abs = Math.abs(v);
    const node = Number.isFinite(abs) ? t.numericLiteral(abs) : t.identifier('Infinity');
    return v < 0 ? t.unaryExpression('-', node) : node;
  }
  return null;
}
