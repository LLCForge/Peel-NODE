import * as normalize from '../passes/00-normalize.js';
import * as unpack from '../passes/10-unpack-wrapper.js';
import * as predecoders from '../passes/20-predecoders.js';
import * as literals from '../passes/25-literals.js';
import * as iifeArgs from '../passes/23-iife-args.js';
import * as constArrays from '../passes/27-const-arrays.js';
import * as constObjects from '../passes/28-const-objects.js';
import * as wrappers from '../passes/29-wrappers.js';
import * as stringArray from '../passes/30-string-array.js';
import * as runtimeDecoders from '../passes/35-runtime-decoders.js';
import * as runtimeFunctions from '../passes/36-runtime-functions.js';
import * as evalInline from '../passes/38-eval-inline.js';
import * as rgf from '../passes/39-rgf.js';
import * as flatFns from '../passes/47-flat-fns.js';
import * as cffScope from '../passes/46-cff-scope.js';
import * as confuserRuntime from '../passes/48-confuser-runtime.js';
import * as proxy from '../passes/40-proxy.js';
import * as constFold from '../passes/50-const-fold.js';
import * as opaque from '../passes/60-opaque.js';
import * as controlFlow from '../passes/70-control-flow.js';
import * as stateVar from '../passes/74-state-var.js';
import * as vm from '../passes/75-vm.js';
import * as unflatten from '../passes/76-unflatten.js';
import * as vmLift from '../passes/77-vm-lift.js';
import * as antiTiming from '../passes/79-anti-timing.js';
import * as deadCode from '../passes/80-dead-code.js';
import * as simplify from '../passes/85-simplify.js';
import * as unused from '../passes/90-unused.js';
import * as webpack from '../passes/93-webpack.js';
import * as rename from '../passes/95-rename.js';
import * as opaqueSmt from '../passes/62-opaque-smt.js';
import * as ssaOpt from '../passes/55-ssa-opt.js';
import * as loopOpt from '../passes/57-loop-opt.js';
import * as specializeFns from '../passes/58-specialize.js';
import * as cfgOpt from '../passes/87-cfg-opt.js';
import * as babelHelpers from '../passes/96-babel.js';
import * as classes from '../passes/96-classes.js';
import * as letConst from '../passes/97-let-const.js';
import * as mergeVars from '../passes/97-merge-vars.js';
import * as moveDecls from '../passes/97-move-decls.js';
import * as modernSyntax from '../passes/97-modern-syntax.js';
import * as destructure from '../passes/97-destructure.js';
import * as dedupe from '../passes/98-dedupe.js';
import * as extract from '../passes/98-extract.js';
import * as magic from '../passes/98-magic.js';
import * as annotate from '../passes/99-annotate.js';
import * as comments from '../passes/99-comments.js';
import * as staticStrings from '../passes/31-static-strings.js';
import * as integrity from '../passes/24-integrity.js';
import * as confuser from '../passes/37-confuser.js';
import * as indirection from '../passes/42-indirection.js';
import * as flow from '../passes/78-flow.js';
import * as deadExtra from '../passes/82-dead-extra.js';
import * as sourcemap from '../passes/05-sourcemap.js';
import * as staticDecode from '../passes/26-static-decode.js';
import * as restructure from '../passes/86-restructure.js';
import * as regenerator from '../passes/79-regenerator.js';

// Dizi sırası çalışma sırasıdır.
// level: 1=güvenli 2=normal 3=agresif 4=maksimum
// needs: 'sandbox' ise sandbox yokken pass atlanır (diğerleri bağlam varsa onu kullanır, yoksa da çalışır)
// finish: çözme pass'leri sabitlendikten sonra çalışan okunabilirlik pass'i
export const PASSES = [
  { id: 'normalize',    level: 1, kind: 'text', needs: null,      mod: normalize },
  { id: 'sourcemap',    level: 1, kind: 'text', needs: null,      mod: sourcemap },
  { id: 'unpack',       level: 1, kind: 'text', needs: null,      mod: unpack },
  { id: 'predecoders',  level: 1, kind: 'text', needs: 'sandbox', mod: predecoders },
  { id: 'integrity',    level: 1, kind: 'ast',  needs: 'sandbox', mod: integrity },
  { id: 'literals',     level: 1, kind: 'ast',  needs: null,      mod: literals },
  { id: 'static-decode', level: 1, kind: 'ast', needs: null,      mod: staticDecode },
  { id: 'iife-args',    level: 2, kind: 'ast',  needs: null,      mod: iifeArgs },
  { id: 'const-arrays', level: 1, kind: 'ast',  needs: null,      mod: constArrays },
  { id: 'const-objects', level: 1, kind: 'ast',  needs: null,      mod: constObjects },
  { id: 'wrappers',     level: 2, kind: 'ast',  needs: null,      mod: wrappers },
  { id: 'static-strings', level: 2, kind: 'ast', needs: null,     mod: staticStrings },
  { id: 'string-array', level: 2, kind: 'ast',  needs: 'sandbox', mod: stringArray },
  { id: 'runtime-decoders', level: 2, kind: 'ast', needs: 'sandbox', mod: runtimeDecoders },
  { id: 'runtime-functions', level: 3, kind: 'ast', needs: 'sandbox', mod: runtimeFunctions },
  { id: 'eval-inline',  level: 2, kind: 'ast',  needs: null,      mod: evalInline },
  { id: 'rgf',          level: 2, kind: 'ast',  needs: null,      mod: rgf },
  { id: 'confuser',     level: 2, kind: 'ast',  needs: null,      mod: confuser },
  { id: 'proxy',        level: 2, kind: 'ast',  needs: null,      mod: proxy },
  { id: 'indirection',  level: 2, kind: 'ast',  needs: null,      mod: indirection },
  { id: 'flat-fns',     level: 2, kind: 'ast',  needs: null,      mod: flatFns },
  { id: 'const-fold',   level: 1, kind: 'ast',  needs: 'sandbox', mod: constFold },
  { id: 'dead-code',    level: 2, kind: 'ast',  needs: null,      mod: deadCode },
  { id: 'confuser-runtime', level: 2, kind: 'ast', needs: null,   mod: confuserRuntime },
  { id: 'opaque',       level: 2, kind: 'ast',  needs: null,      mod: opaque },
  { id: 'opaque-smt',   level: 2, kind: 'ast',  needs: null,      mod: opaqueSmt },
  { id: 'ssa-opt',      level: 3, kind: 'ast',  needs: null,      mod: ssaOpt },
  { id: 'loop-opt',     level: 3, kind: 'ast',  needs: null,      mod: loopOpt },
  { id: 'specialize',   level: 4, kind: 'ast',  needs: null,      mod: specializeFns },
  { id: 'state-var',    level: 3, kind: 'ast',  needs: null,      mod: stateVar },
  { id: 'vm-lift',      level: 3, kind: 'ast',  needs: null,      mod: vmLift },
  { id: 'unflatten',    level: 3, kind: 'ast',  needs: null,      mod: unflatten },
  { id: 'cff-scope',    level: 3, kind: 'ast',  needs: null,      mod: cffScope },
  { id: 'vm',           level: 3, kind: 'ast',  needs: 'sandbox', mod: vm },
  { id: 'anti-timing',  level: 2, kind: 'ast',  needs: null,      mod: antiTiming },
  { id: 'control-flow', level: 3, kind: 'ast',  needs: null,      mod: controlFlow },
  { id: 'flow',         level: 2, kind: 'ast',  needs: null,      mod: flow },
  { id: 'regenerator',  level: 2, kind: 'ast',  needs: null,      mod: regenerator },
  { id: 'simplify',     level: 2, kind: 'ast',  needs: null,      mod: simplify },
  { id: 'cfg-opt',      level: 3, kind: 'ast',  needs: null,      mod: cfgOpt },
  { id: 'restructure',  level: 2, kind: 'ast',  needs: null,      mod: restructure },
  { id: 'dead-extra',   level: 2, kind: 'ast',  needs: null,      mod: deadExtra },
  { id: 'unused',       level: 3, kind: 'ast',  needs: null,      mod: unused },
  { id: 'webpack',      level: 2, kind: 'ast',  needs: null,      mod: webpack },
  { id: 'rename',       level: 4, kind: 'ast',  needs: null,      mod: rename },
  // okunabilirlik: Babel kalıntıları, modern sözdizimi, birleştirme/çıkarma, adlandırma ve yorumlar
  { id: 'babel',        level: 4, kind: 'ast',  needs: null,      mod: babelHelpers, finish: true },
  { id: 'classes',      level: 4, kind: 'ast',  needs: null,      mod: classes, finish: true },
  { id: 'let-const',    level: 4, kind: 'ast',  needs: null,      mod: letConst, finish: true },
  { id: 'merge-vars',   level: 4, kind: 'ast',  needs: null,      mod: mergeVars, finish: true },
  { id: 'move-decls',   level: 4, kind: 'ast',  needs: null,      mod: moveDecls, finish: true },
  { id: 'modern-syntax', level: 4, kind: 'ast', needs: null,      mod: modernSyntax, finish: true },
  { id: 'destructure',  level: 4, kind: 'ast',  needs: null,      mod: destructure, finish: true },
  { id: 'dedupe',       level: 4, kind: 'ast',  needs: null,      mod: dedupe, finish: true },
  { id: 'extract',      level: 4, kind: 'ast',  needs: null,      mod: extract, finish: true },
  { id: 'magic',        level: 4, kind: 'ast',  needs: null,      mod: magic, finish: true },
  { id: 'annotate',     level: 4, kind: 'ast',  needs: null,      mod: annotate, finish: true },
  { id: 'comments',     level: 4, kind: 'ast',  needs: null,      mod: comments, finish: true },
];

export const byId = (id) => PASSES.find((p) => p.id === id);
