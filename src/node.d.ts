import type { HistoryStore, Style } from './index.js';

export function fileStore(path?: string): HistoryStore;
export function defaultHistoryPath(): string;
export function findStyle(startDir: string): Promise<Style>;
export interface SemgrepFinding { ruleId: string; message: string; level: 'error' | 'warning' | 'note'; line: number; endLine: number | null; code: string }
export function normalizeSemgrep(json: string | object): SemgrepFinding[];
export function runSemgrep(code: string, o?: { config?: string; bin?: string }): Promise<SemgrepFinding[]>;
export const SEMGREP_RULES: string;
export interface ServerOptions { host?: string; port?: number; token?: string | null; maxBody?: number; timeoutMs?: number; log?: (m: string) => void }
export function startServer(o?: ServerOptions): Promise<{ url: string; token: string; port: number; close(): Promise<void> }>;
