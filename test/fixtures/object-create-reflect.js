// E115: nesne oluşturma tanımlayıcıları → nesne literali; E116: yansıtma API çağrıları → doğrudan biçim
function sum(a, b) { var s = a + b; return s; }
function main() {
  var base = Object.create(null, {
    name: { value: "peel", writable: true, enumerable: true, configurable: true },
    size: { value: 3, writable: true, enumerable: true, configurable: true },
  });
  var plain = Object.create(Object.prototype);
  var cfg = { mode: "fast", level: 2 };
  Reflect.set(cfg, "level", 4);
  var out = [base.name, base.size, Object.getPrototypeOf(base) === null, Object.keys(plain).length];
  out.push(Reflect.get(cfg, "mode"), cfg.level, Reflect.has(cfg, "mode"), Reflect.apply(sum, undefined, [cfg.level, 5]));
  return out.join(",");
}
console.log(main());
// EXPECT: __proto__: null,
// EXPECT: name: "peel",
// EXPECT: const plain = {};
// EXPECT: cfg.level = 4;
// EXPECT: "mode" in cfg
// EXPECT: sum(cfg.level, 5)
// GONE: Reflect
// GONE: Object.create
