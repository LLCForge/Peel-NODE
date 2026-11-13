// webpack 5.112.2 + webpack-obfuscator 3.6.1 (dev-eval-plain)
// NEEDLES: "https://api.example.com/v1/collect" | "alpha" | "production" | toUpperCase
/*
 * ATTENTION: The "eval" devtool has been used (maybe by default in mode: "development").
 * This devtool is neither made for production nor for readable output files.
 * It uses "eval()" calls to create a separate source file in the browser devtools.
 * If you are trying to read the output file, select a different devtool (https://webpack.js.org/configuration/devtool/)
 * or disable the default devtool with "devtool: false".
 * If you are looking for production-ready output files, see mode: "production" (https://webpack.js.org/configuration/mode/).
 */
/******/ (() => { // webpackBootstrap
/******/ 	var __webpack_modules__ = ({

/***/ "./src/config.js"
/*!***********************!*\
  !*** ./src/config.js ***!
  \***********************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

"use strict";
eval("{__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   \"default\": () => (__WEBPACK_DEFAULT_EXPORT__)\n/* harmony export */ });\n/* harmony default export */ const __WEBPACK_DEFAULT_EXPORT__ = ({ endpoint: \"https://api.example.com/v1/collect\", retries: 3, debug: false });\n\n\n//# sourceURL=webpack://wp-src/./src/config.js?\n}");

/***/ },

/***/ "./src/greet.js"
/*!**********************!*\
  !*** ./src/greet.js ***!
  \**********************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

"use strict";
eval("{__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   Counter: () => (/* binding */ Counter),\n/* harmony export */   greet: () => (/* binding */ greet)\n/* harmony export */ });\nfunction greet(name) { return \"Hello, \" + name + \"!\"; }\nclass Counter { constructor() { this.n = 0; } inc() { this.n++; return this.n; } }\n\n\n//# sourceURL=webpack://wp-src/./src/greet.js?\n}");

/***/ },

/***/ "./src/index.js"
/*!**********************!*\
  !*** ./src/index.js ***!
  \**********************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

"use strict";
eval("{__webpack_require__.r(__webpack_exports__);\n/* harmony import */ var _greet_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./greet.js */ \"./src/greet.js\");\n/* harmony import */ var _config_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./config.js */ \"./src/config.js\");\n/* harmony import */ var _util_sum_cjs__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ./util/sum.cjs */ \"./src/util/sum.cjs\");\n/* harmony import */ var _util_sum_cjs__WEBPACK_IMPORTED_MODULE_2___default = /*#__PURE__*/__webpack_require__.n(_util_sum_cjs__WEBPACK_IMPORTED_MODULE_2__);\n\n\n\nconst c = new _greet_js__WEBPACK_IMPORTED_MODULE_0__.Counter(); c.inc(); c.inc();\nconst words = [\"alpha\", \"beta\", \"gamma\"].map((w) => w.toUpperCase());\nconsole.log((0,_greet_js__WEBPACK_IMPORTED_MODULE_0__.greet)(\"PEEL\"));\nconsole.log(_config_js__WEBPACK_IMPORTED_MODULE_1__[\"default\"].endpoint, _config_js__WEBPACK_IMPORTED_MODULE_1__[\"default\"].retries * 2, _util_sum_cjs__WEBPACK_IMPORTED_MODULE_2___default()([1, 2, 3, 4]));\nconsole.log(words.join(\"-\"), c.n, typeof _config_js__WEBPACK_IMPORTED_MODULE_1__[\"default\"].debug);\nif (_config_js__WEBPACK_IMPORTED_MODULE_1__[\"default\"].debug) { console.log(\"debug mode\"); } else { console.log(\"production\"); }\n\n\n//# sourceURL=webpack://wp-src/./src/index.js?\n}");

/***/ },

/***/ "./src/util/sum.cjs"
/*!**************************!*\
  !*** ./src/util/sum.cjs ***!
  \**************************/
(module) {

eval("{module.exports = function sum(list) { var s = 0; for (var i = 0; i < list.length; i++) s += list[i]; return s; };\n\n\n//# sourceURL=webpack://wp-src/./src/util/sum.cjs?\n}");

/***/ }

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	const __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		const cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		const module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		if (!(moduleId in __webpack_modules__)) {
/******/ 			delete __webpack_module_cache__[moduleId];
/******/ 			const e = new Error("Cannot find module '" + moduleId + "'");
/******/ 			e.code = 'MODULE_NOT_FOUND';
/******/ 			throw e;
/******/ 		}
/******/ 		__webpack_modules__[moduleId](module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/compat get default export */
/******/ 	// getDefaultExport function for compatibility with non-harmony modules
/******/ 	__webpack_require__.n = (module) => {
/******/ 		const getter = module && module.__esModule ?
/******/ 			() => (module['default']) :
/******/ 			() => (module);
/******/ 		__webpack_require__.d(getter, { a: getter });
/******/ 		return getter;
/******/ 	};
/******/ 	
/******/ 	/* webpack/runtime/define property getters */
/******/ 	// define getter/value functions for harmony exports
/******/ 	__webpack_require__.d = (exports, definition) => {
/******/ 		for(var key in definition) {
/******/ 			if(__webpack_require__.o(definition, key) && !__webpack_require__.o(exports, key)) {
/******/ 				Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
/******/ 			}
/******/ 		}
/******/ 	};
/******/ 	
/******/ 	/* webpack/runtime/hasOwnProperty shorthand */
/******/ 	__webpack_require__.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop));
/******/ 	
/******/ 	/* webpack/runtime/make namespace object */
/******/ 	// define __esModule on exports
/******/ 	__webpack_require__.r = (exports) => {
/******/ 		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 		Object.defineProperty(exports, '__esModule', { value: true });
/******/ 	};
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module can't be inlined because the eval devtool is used.
/******/ 	let __webpack_exports__ = __webpack_require__("./src/index.js");
/******/ 	
/******/ })()
;
