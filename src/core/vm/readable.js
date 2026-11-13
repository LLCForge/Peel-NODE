import * as t from '@babel/types';
import { generate } from '../../util/ast.js';
import { parse } from '../parse.js';
import { findVms } from './detect.js';

// Okunur yorumlayıcı (E652): ham VM kaynağında roller anlamlı adlarla yeniden adlandırılır
// (bytecode, pc, stack, regs, consts, opcode) ve her handler'ın önüne komut adı ile anlamı yazılır.

const ROLE_NAMES = { code: 'bytecode', pc: 'pc', stack: 'stack', sp: 'sp', regs: 'regs', consts: 'consts', op: 'opcode' };

export function readableInterpreter(rawSource, handlers) {
  let ast;
  try { ast = parse(rawSource); } catch { return null; }
  const [vm] = findVms(ast);
  if (!vm) return null;
  const scope = vm.loopPath.scope;
  for (const [role, nice] of Object.entries(ROLE_NAMES)) {
    const name = vm.roles[role];
    if (!name || name === nice) continue;
    const b = scope.getBinding(name);
    // hedef ad zaten kullanılıyorsa yeniden adlandırma yapılmaz
    if (!b || scope.hasBinding(nice) || scope.hasGlobal(nice)) continue;
    b.scope.rename(name, nice);
  }
  const byKey = new Map(handlers.map((h) => [String(h.key), h]));
  for (const h of vm.handlers) {
    const info = byKey.get(String(h.key));
    if (!info) continue;
    const target = vm.style === 'table' ? h.fn : h.node;
    t.addComment(target, 'leading', ` ${info.staticName ?? `OP_${h.key}`}: ${info.semantics}`.slice(0, 240), false);
  }
  return generate(ast, { comments: true, retainLines: false, jsescOption: { minimal: true } }).code;
}
