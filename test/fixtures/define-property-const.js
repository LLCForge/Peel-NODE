// E117: yazılamaz/yapılandırılamaz Object.defineProperty sabit değeri sonraki okumalara yazılır
function build() {
  var conf = { name: "peel" };
  var early = conf.version;
  Object.defineProperty(conf, "version", { value: 7 });
  var later = conf.version * 2;
  var read = function () { return conf.version + 1; };
  return [String(early), later, read(), conf.name].join(",");
}
console.log(build());
// EXPECT: early = conf.version;
// EXPECT: [String(early), 14, read(), conf.name]
// EXPECT: return 8;
