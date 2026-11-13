'use strict';
// PEEL VS Code eklentisi (H158). Tüm çözme işlemi eklenti sürecinde, PEEL'in QuickJS sandbox'ında yapılır;
// kod hiçbir sunucuya gönderilmez. peel-js bir ES modülü olduğundan ilk kullanımda dinamik olarak yüklenir.
const vscode = require('vscode');
const { createService } = require('./service.js');

let servicePromise = null;
const service = () => (servicePromise ??= import('peel-js').then((m) => createService(m)));

let output;
let diagnostics;

function config() {
  const c = vscode.workspace.getConfiguration('peel');
  return { level: c.get('level', 4), sandbox: c.get('sandbox', true), deep: c.get('deep', true), lang: c.get('language', 'tr') };
}

const MAX_INPUT = 20 * 1024 * 1024;

function sourceText(editor, selectionOnly) {
  if (!editor) throw new Error('Açık bir editör yok');
  const sel = editor.selection;
  const text = selectionOnly && sel && !sel.isEmpty ? editor.document.getText(sel) : editor.document.getText();
  if (!text.trim()) throw new Error('Çözülecek kod yok');
  if (text.length > MAX_INPUT) throw new Error('Kod çok büyük (en fazla 20 MB)');
  return text;
}

// İptal edilebilir ilerleme bildirimi; iptal AbortSignal olarak pipeline'a iletilir
function withProgress(title, fn) {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (_p, token) => {
    const ac = new AbortController();
    token.onCancellationRequested(() => ac.abort());
    const onLog = (m, lv) => output.appendLine(`[${lv}] ${m}`);
    return fn({ signal: ac.signal, onLog });
  });
}

async function openBeside(content, language) {
  const doc = await vscode.workspace.openTextDocument({ content, language });
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  return doc;
}

function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      if (/İptal edildi/.test(e.message)) return;
      output.appendLine(`[err] ${e.stack ?? e.message}`);
      vscode.window.showErrorMessage(e.message);
    }
  };
}

async function deobfuscateCommand(selectionOnly) {
  const editor = vscode.window.activeTextEditor;
  const text = sourceText(editor, selectionOnly);
  const svc = await service();
  const r = await withProgress('PEEL: çözülüyor', (ctx) => svc.deobfuscateText(text, config(), ctx));
  if (selectionOnly && !editor.selection.isEmpty && vscode.workspace.getConfiguration('peel').get('replaceSelection', false)) {
    await editor.edit((b) => b.replace(editor.selection, r.code));
  } else {
    await openBeside(r.code, 'javascript');
  }
  if (r.verified === false && config().sandbox) vscode.window.showWarningMessage('PEEL: davranış sandbox\'ta doğrulanamadı; çıktıyı gözden geçirin.');
}

async function analyzeCommand() {
  const editor = vscode.window.activeTextEditor;
  const text = sourceText(editor, false);
  const svc = await service();
  const a = await withProgress('PEEL: analiz ediliyor', (ctx) => svc.analyzeText(text, config(), ctx));
  const codeDoc = await openBeside(a.result.code, 'javascript');
  diagnostics.set(codeDoc.uri, svc.diagnostics(a.report, a.result.code).map((d) => {
    const line = Math.min(d.line, codeDoc.lineCount - 1);
    const sev = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, information: vscode.DiagnosticSeverity.Information }[d.severity];
    const diag = new vscode.Diagnostic(codeDoc.lineAt(line).range, d.message, sev);
    diag.source = 'PEEL';
    return diag;
  }));
  const md = await vscode.workspace.openTextDocument({ content: svc.reportMarkdown(a, config().lang), language: 'markdown' });
  await vscode.commands.executeCommand('markdown.showPreviewToSide', md.uri);
}

async function compareCommand(uri) {
  const svc = await service();
  let first;
  if (uri instanceof vscode.Uri) first = (await vscode.workspace.openTextDocument(uri)).getText();
  else first = sourceText(vscode.window.activeTextEditor, false);
  const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Yeni sürümle karşılaştır', filters: { JavaScript: ['js', 'mjs', 'cjs'] } });
  if (!picked?.length) return;
  const second = (await vscode.workspace.openTextDocument(picked[0])).getText();
  const c = await withProgress('PEEL: sürümler karşılaştırılıyor', (ctx) => svc.compareTexts(first, second, config(), ctx));
  const a = await vscode.workspace.openTextDocument({ content: c.oldCode, language: 'javascript' });
  const b = await vscode.workspace.openTextDocument({ content: c.newCode, language: 'javascript' });
  await vscode.commands.executeCommand('vscode.diff', a.uri, b.uri, 'PEEL: eski ↔ yeni (çözülmüş)');
  output.appendLine(c.summary);
  output.show(true);
  if (c.diff.techniques?.new.length) vscode.window.showWarningMessage(`PEEL: yeni gizleme tekniği: ${c.diff.techniques.new.map((x) => x.name).join(', ')}`);
}

function activate(context) {
  output = vscode.window.createOutputChannel('PEEL');
  diagnostics = vscode.languages.createDiagnosticCollection('peel');
  context.subscriptions.push(
    output,
    diagnostics,
    vscode.commands.registerCommand('peel.deobfuscateFile', guard(() => deobfuscateCommand(false))),
    vscode.commands.registerCommand('peel.deobfuscateSelection', guard(() => deobfuscateCommand(true))),
    vscode.commands.registerCommand('peel.analyze', guard(analyzeCommand)),
    vscode.commands.registerCommand('peel.compare', guard(compareCommand)),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
