#!/usr/bin/env node
// PEEL komut satırı: tarayıcıdakiyle aynı motor, aynı QuickJS sandbox.
// Kullanım: peel <girdi.js> [-o çıktı.js] [--report rapor.json] ... | peel <alt komut> ...  (peel --help)
import { runCommand } from '../src/cli/run.js';
import { findCommand } from '../src/cli/commands.js';
import { UsageError } from '../src/cli/args.js';
import { EXIT } from '../src/cli/common.js';

const argv = process.argv.slice(2);
const sub = argv.length ? findCommand(argv[0]) : null;

try {
  const code = sub ? await sub(argv.slice(1)) : await runCommand(argv);
  process.exitCode = code ?? EXIT.OK;
} catch (e) {
  if (e instanceof UsageError) {
    console.error(e.message);
    process.exitCode = EXIT.USAGE;
  } else {
    console.error(`Hata: ${e.message}`);
    process.exitCode = EXIT.ERROR;
  }
}
