function hi(...__p_ssdN_varMask){return"Hi, "+__p_ssdN_varMask[0]}var total=6*7;console["log"](hi("PEEL"),total);
// EXPECT: function hi(arg0) {
// EXPECT: return "Hi, " + arg0;
// GONE: ...
