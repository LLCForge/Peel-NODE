// regenerator çalışma zamanının yalnızca bu dosyanın kullandığı yüzeyi (fonksiyonlar çağrılmıyor); _asyncToGenerator Babel'in gerçek yardımcısı
var regeneratorRuntime = { mark: function (f) { return f; }, wrap: function () { return {}; } };
function asyncGeneratorStep(gen, resolve, reject, _next, _throw, key, arg) { try { var info = gen[key](arg); var value = info.value; } catch (error) { reject(error); return; } if (info.done) { resolve(value); } else { Promise.resolve(value).then(_next, _throw); } }
function _asyncToGenerator(fn) { return function () { var self = this, args = arguments; return new Promise(function (resolve, reject) { var gen = fn.apply(self, args); function _next(value) { asyncGeneratorStep(gen, resolve, reject, _next, _throw, "next", value); } function _throw(err) { asyncGeneratorStep(gen, resolve, reject, _next, _throw, "throw", err); } _next(undefined); }); }; }
var _marked = regeneratorRuntime.mark(counter);
function fetchData(_x) {
  return _fetchData.apply(this, arguments);
}
function _fetchData() {
  _fetchData = _asyncToGenerator(/*#__PURE__*/ regeneratorRuntime.mark(function _callee(url) {
    var res, data;
    return regeneratorRuntime.wrap(function _callee$(_context) {
      while (1) switch (_context.prev = _context.next) {
        case 0:
          _context.next = 2;
          return fetch(url);
        case 2:
          res = _context.sent;
          if (res.ok) {
            _context.next = 5;
            break;
          }
          return _context.abrupt("return", null);
        case 5:
          _context.next = 7;
          return res.json();
        case 7:
          data = _context.sent;
          return _context.abrupt("return", data.items);
        case 9:
        case "end":
          return _context.stop();
      }
    }, _callee);
  }));
  return _fetchData.apply(this, arguments);
}
function counter(limit) {
  return regeneratorRuntime.wrap(function counter$(_context2) {
    while (1) switch (_context2.prev = _context2.next) {
      case 0:
        _context2.next = 2;
        return 1;
      case 2:
        _context2.next = 4;
        return limit;
      case 4:
      case "end":
        return _context2.stop();
    }
  }, _marked);
}
globalThis.fetchData = fetchData;
globalThis.counter = counter;
console.log(typeof fetchData, typeof counter);
// EXPECT: async function _callee(url)
// EXPECT: res = await fetch(url);
// EXPECT: if (!res.ok)
// EXPECT: data = await res.json();
// EXPECT: return data.items;
// EXPECT: function* counter(limit)
// EXPECT: yield 1;
// EXPECT: yield limit;
// GONE: _context
