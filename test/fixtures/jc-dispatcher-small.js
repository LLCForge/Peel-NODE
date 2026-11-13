var __p_OsPy_cache=Object["create"](null);var __p_l1Uv_payload;function __p_g2Zq_dispatcher_0(name,flagArg,returnTypeArg,fnLengths={}){var output;var fns={"aiybMu":function(){var[name]=__p_l1Uv_payload;return"Hi, "+name}};if(flagArg==="X15BZSbsxa"){__p_l1Uv_payload=[]}if(flagArg==="TWb2okyWgv"){function createFunction(){var fn=function(...args){__p_l1Uv_payload=args;return fns[name].apply(this)};var fnLength=fnLengths[name];if(fnLength){__p_hBFh_d_fnLength(fn,fnLength)}return fn}output=__p_OsPy_cache[name]||(__p_OsPy_cache[name]=createFunction())}else{output=fns[name]()}if(returnTypeArg==="DBGNJHOKVu"){return{"rr7l0bisof":output}}else{return output}}function __p_hBFh_d_fnLength(){}var total=6*7;console["log"]((__p_l1Uv_payload=["PEEL"],__p_g2Zq_dispatcher_0("aiybMu","754vgcSUnz","DBGNJHOKVu")["rr7l0bisof"]),total);
// EXPECT: return "Hi, " + name;
// GONE: payload
// GONE: dispatcher
// GONE: Object.create
