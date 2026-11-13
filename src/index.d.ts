// PEEL kütüphane tipleri (H157)

export type LogLevel = 'info' | 'warn' | 'err' | 'ok';
export type PassState = 'run' | 'ok' | 'skip' | 'fail';

export interface Sandbox {
  run(code: string, options?: { timeoutMs?: number; post?: string; config?: unknown }): Promise<SandboxRunResult>;
  open(code: string, options?: { timeoutMs?: number }): Promise<{ ok: boolean; token?: number; error?: string; runError?: string }>;
  close(token: number): Promise<unknown>;
  [key: string]: unknown;
}

export interface SandboxRunResult {
  ok: boolean;
  error?: string;
  out: string[];
  res?: unknown[];
  net?: unknown[];
  [key: string]: unknown;
}

export interface Snapshot {
  id: string;
  round: number;
  code: string;
}

export interface PassEvent {
  id: string;
  round: number;
  state: Exclude<PassState, 'run'>;
  ms: number;
  reason?: string;
}

export interface PluginContext {
  onLog(message: string, level?: LogLevel): void;
  bump(stat: string, n?: number): void;
  level: number;
  sandbox: Sandbox | null;
  t: typeof import('@babel/types');
  traverse: (ast: unknown, visitors: object) => void;
  gen: (node: unknown) => string;
  parse: (code: string) => unknown;
}

export interface PeelPlugin {
  id: string;
  kind: 'ast' | 'text';
  level?: 1 | 2 | 3 | 4;
  needs?: null | 'sandbox';
  after?: string;
  run(input: unknown, ctx: PluginContext): void | string | Promise<void | string>;
}

export interface DeobfuscateOptions {
  /** 1=güvenli 2=normal 3=agresif 4=maksimum (varsayılan 4) */
  level?: 1 | 2 | 3 | 4;
  /** true (varsayılan): paylaşılan QuickJS sandbox; false: sandbox'sız; nesne: kendi sandbox'ın */
  sandbox?: boolean | Sandbox | null;
  /** her pass'ten sonra davranış karşılaştırması (sandbox varken varsayılan true) */
  deep?: boolean;
  only?: string[] | null;
  signal?: AbortSignal | null;
  plugins?: PeelPlugin[];
  onLog?: (message: string, level: LogLevel) => void;
  onProgress?: (percent: number) => void;
  onPass?: (id: string, state: PassState) => void;
  onSnapshot?: (snapshot: Snapshot) => void;
}

export interface DeobfuscateResult {
  code: string;
  stats: Record<string, number>;
  events: PassEvent[];
  text: string;
  verified?: boolean;
  error?: string;
}

export interface ThreatClass { id: string; score: number; evidence: string[] }

export interface AnalysisReport {
  fingerprint: Array<{ name: string; confidence: number; evidence: string[] }>;
  iocs: Record<'urls' | 'ips' | 'emails' | 'wallets' | 'jwts' | 'domains' | 'secrets', string[]>;
  threat: {
    classes: ThreatClass[];
    risk: { score: number; level: 'none' | 'low' | 'medium' | 'high' };
    privacy: Record<string, unknown>;
    libraries: Array<{ name: string; version: string | null }>;
    missingGlobals: string[];
    yara: string | null;
    ids: string | null;
  };
  encodings: unknown;
  apis: Array<{ name: string; count: number; why: string }>;
  regexes: string[];
  runtime: Record<string, unknown>;
  rollbacks: PassEvent[];
  passTimes: Array<{ id: string; ms: number }>;
  metrics: Record<string, number | string>;
}

export function createSandbox(): Promise<Sandbox>;
export function deobfuscate(input: string, options?: DeobfuscateOptions): Promise<DeobfuscateResult>;
export function analyze(o: { input: string; output: string; text?: string; events?: PassEvent[]; sandbox?: boolean | Sandbox | null; config?: unknown }): Promise<AnalysisReport>;
export function peel(input: string, options?: DeobfuscateOptions): Promise<DeobfuscateResult & { report: AnalysisReport | null }>;
export function passes(): Array<{ id: string; level: number; kind: 'ast' | 'text'; needs: null | 'sandbox' }>;

// G141/G142/G145/G147/G148
export interface FunctionInfo { index: number; name: string; line: number; size: number; hash: string }
export interface FunctionRow {
  status: 'same' | 'changed' | 'added' | 'removed';
  old: FunctionInfo | null;
  new: FunctionInfo | null;
  similarity: number;
  via: string | null;
  changes?: { stringsAdded: string[]; stringsRemoved: string[]; globalsAdded: string[]; globalsRemoved: string[]; sizeDelta: number };
}
export interface SemanticDiff {
  summary: { same: number; changed: number; added: number; removed: number; equivalent: boolean; stringsAdded: string[]; stringsRemoved: string[]; globalsAdded: string[]; globalsRemoved: string[] };
  functions: FunctionRow[];
  techniques: { before: string[]; after: string[]; new: Array<{ id: string; name: string }>; gone: string[] } | null;
}
export function semanticDiff(oldCode: string, newCode: string, o?: { oldInput?: string; newInput?: string; threshold?: number }): SemanticDiff;
export function formatDiff(diff: SemanticDiff, lang?: 'tr' | 'en'): string;
export function extractFunctions(code: string): { ast: unknown; fns: Array<FunctionInfo & { tokens: string[]; callees: number[] }> };
export function matchFunctions(a: unknown[], b: unknown[], o?: { threshold?: number }): { matched: Array<{ old: number; new: number; similarity: number; via: string }>; added: number[]; removed: number[] };
export function portNames(oldCode: string, newCode: string, o?: { threshold?: number }): Promise<{ code: string; renamed: Array<{ from: string; to: string }>; skipped: number }>;

// G143/G144/G146/G155
export interface HistoryStore { load(): Promise<object[]>; save(entries: object[]): Promise<void> }
export interface HistoryEntry {
  id: string; time: number; name: string; source: string; label: string; note: string;
  inputHash: string; outputHash: string | null; inputSize: number; outputSize: number;
  techniques: string[]; stats: Record<string, number> | null; input: string | null; output: string | null;
}
export interface History {
  list(): Promise<Array<Omit<HistoryEntry, 'input' | 'output'> & { hasCode: boolean }>>;
  get(id: string): Promise<HistoryEntry | null>;
  add(o: { name?: string; source?: string; input: string; output?: string; label?: string; note?: string; stats?: Record<string, number> | null }): Promise<HistoryEntry>;
  update(id: string, o: { label?: string; note?: string }): Promise<HistoryEntry | null>;
  remove(id: string): Promise<boolean>;
  clear(): Promise<void>;
  seen(input: string, output?: string): Promise<{ exact: HistoryEntry[]; sameOutput: HistoryEntry[]; similar: Array<{ entry: HistoryEntry; score: number }> }>;
  versions(source: string): Promise<HistoryEntry[]>;
  track(o: { source: string; name?: string; input: string; output: string; label?: string; note?: string }): Promise<{ changed: boolean; entry: HistoryEntry; previous: HistoryEntry | null; diff: SemanticDiff | null }>;
}
export function createHistory(store: HistoryStore): History;
export function memoryStore(initial?: object[]): HistoryStore;

// J196 / G152
export interface SharePayload { input: string; output?: string; name?: string; note?: string }
export function encodeShare(payload: SharePayload, o?: { password?: string }): Promise<string>;
export function decodeShare(fragment: string, o?: { password?: string }): Promise<(SharePayload & { v: 1 }) | null>;
export function isEncrypted(fragment: string): boolean;
export function shareUrl(base: string, fragment: string): string;
export function buildReportHtml(o: { input: string; output: string; report?: AnalysisReport | null; techniques?: unknown[]; reasons?: unknown[]; name?: string; lang?: 'tr' | 'en' }): string;

// G151 / G153 / G154
export function fastImportStream(o: { input: string; snapshots?: Snapshot[]; output?: string; file?: string; branch?: string; time?: number }): string;
export function symbolMap(files: Array<{ name: string; code: string }>): {
  shared: Array<{ name: string; definedIn: Array<{ file: string; line: number; kind: string }>; usedIn: Array<{ file: string; line: number }> }>;
  conflicts: unknown[]; external: string[]; edges: Array<{ from: string; to: string; symbols: string[] }>; errors: Array<{ file: string; error: string }>;
};
export function renameAcross(files: Array<{ name: string; code: string }>, renames: Record<string, string>): Promise<Array<{ name: string; code: string; renamed: number }>>;
export interface AsarFile { path: string; size: number; offset: number; unpacked: boolean; executable: boolean; link?: string }
export function readAsar(buf: Uint8Array): { files: AsarFile[]; read(path: string): Uint8Array; readText(path: string): string };
export function writeAsar(entries: Record<string, Uint8Array | string>): Uint8Array;
export function isScript(path: string): boolean;

// H164
export interface PeelProjectFile { name: string; input: string; output: string; label: string; note: string; renames: Record<string, string> }
export interface PeelProject {
  format: 'peel-project'; version: 1; name: string; created: string; updated: string;
  options: { level: 1 | 2 | 3 | 4; sandbox: boolean; deep: boolean; only: string[] | null };
  rules: string; notes: string; files: PeelProjectFile[];
}
export function createProject(o?: Partial<Pick<PeelProject, 'name' | 'rules' | 'notes'>> & { files?: Partial<PeelProjectFile>[]; options?: Partial<PeelProject['options']> }): PeelProject;
export function parseProject(text: string): PeelProject;
export function serializeProject(p: PeelProject): string;
export function validateProject(p: unknown): PeelProject;
export function upsertFile(p: PeelProject, file: Partial<PeelProjectFile> & { name: string }): PeelProject;
export function applyRenames(code: string, renames: Record<string, string>): Promise<{ code: string; applied: number; skipped: string[] }>;

// H165 / H166 / H167
export function definePlugin(p: PeelPlugin, coreIds?: string[]): unknown;
export function importPluginSource(code: string): Promise<PeelPlugin>;
export function generateKeyPair(): Promise<{ publicKey: string; privateKey: string }>;
export interface PluginManifest { id: string; name?: string; version: string; description?: string; author?: string; homepage?: string }
export interface PluginBundle { format: 'peel-plugin'; manifest: PluginManifest; code: string; publicKey: string; signature: string }
export function signPlugin(o: { manifest: PluginManifest; code: string; privateKey: string; publicKey: string }): Promise<PluginBundle>;
export function verifyPlugin(bundle: PluginBundle | string, trustedKeys: string[]): Promise<{ manifest: PluginManifest; code: string; publicKey: string }>;
export function keyFingerprint(publicKey: string): Promise<string>;
export interface Rule { name: string; pattern: unknown; replacement: unknown; guards: Array<{ kind: string; name: string }>; line: number }
export function parseRules(text: string): Rule[];
export function applyRules(ast: unknown, rules: Rule[]): { count: number; byRule: Record<string, number> };
export function rulesPlugin(text: string, o?: { id?: string; after?: string }): PeelPlugin;

// H171 / H173
export interface Style { printWidth?: number; tabWidth?: number; useTabs?: boolean; semi?: boolean; singleQuote?: boolean; quoteProps?: string; trailingComma?: string; bracketSpacing?: boolean; bracketSameLine?: boolean; arrowParens?: string; endOfLine?: string }
export function resolveStyle(src?: { prettierrc?: string; packageJson?: string; eslintrc?: string; editorconfig?: string }): Style;
export function formatWithStyle(code: string, style?: Style): Promise<string>;
export function toSarif(report: AnalysisReport, o?: { output?: string; uri?: string; semgrep?: unknown[]; version?: string }): object;

// J191–J200
export interface Technique {
  id: string; name: { tr: string; en: string }; summary: { tr: string; en: string }; why: { tr: string; en: string };
  example: string | null; expect: string | null; passes: string[]; detect: Array<RegExp | ((code: string) => boolean)>;
}
export const TECHNIQUES: Technique[];
export function detectTechniques(code: string): Array<{ id: string; name: string; nameTr: string; hits: number }>;
export function explainWhy(o: { input: string; report?: AnalysisReport | null }): Array<{ id: string; title: { tr: string; en: string }; detail: { tr: string; en: string }; confidence: number; evidence: string[] }>;
export function anonymize(input: string, o?: { output?: string }): { code: string; replaced: Record<string, number>; leaks: Array<{ kind: string; value: string }> };
export function buildFixture(o: { code: string; expect?: string[]; gone?: string[]; level?: number; note?: string }): string;
export function resilienceScore(o: { original: string; deobfuscated: string }): { score: number; recovered: number; structure: number; strings: number; residue: number; details: object };
export const OBFUSCATION_PRESETS: Record<'low' | 'medium' | 'high' | 'max', { label: { tr: string; en: string }; options: object }>;
export function obfuscate(code: string, preset?: 'low' | 'medium' | 'high' | 'max' | object, o?: { seed?: number }): Promise<string>;
export function testOwnCode(code: string, preset: string, o: { deobfuscate: typeof deobfuscate; sandbox?: Sandbox | null; seed?: number; onLog?: (m: string, l: LogLevel) => void }): Promise<object>;
export const PASS_DOCS: Record<string, { tr: string; en: string }>;
export const LESSONS: Technique[];
export function playLesson(id: string, deobfuscate: (input: string, o: object) => Promise<DeobfuscateResult>, o?: object): Promise<{ lesson: Technique; steps: Array<{ pass: string; round: number; code: string; doc: { tr: string; en: string } }>; result: string; solved: boolean }>;
export const CHALLENGES: Array<{ id: string; title: { tr: string; en: string }; difficulty: number; preset: string; seed: number; hint: { tr: string; en: string }; source: string; reveal: string[]; flagHash: string }>;
export function buildChallenge(id: string): Promise<string>;
export function checkFlag(id: string, flag: string): Promise<boolean>;
export const PATTERN_CHANGELOG: Array<{ seq: number; commit: string; date: string; passes: string[]; tr: string[]; en: string[] }>;
