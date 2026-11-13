// E211: kullanılmayan import adları kaldırılır; hiç ad kalmazsa modül yan etkileri için yüklenmeye devam eder
import { used, notUsed } from "./lib.js";
import * as nothing from "./side.js";
import def, { other } from "./mixed.js";
export function run() { return used(def); }
// EXPECT: import { used } from "./lib.js";
// EXPECT: import "./side.js";
// EXPECT: import def from "./mixed.js";
// GONE: notUsed
// GONE: nothing
// GONE: other
