#!/usr/bin/env node
// PEEL-NODE komut satırı: tarayıcıdakiyle aynı motor, aynı QuickJS sandbox.
// Girdi .exe (pkg/nexe/SEA), .tgz (npm), .jsc (bytenode), .asar ya da .zip ise önce bellekte açılır,
// sonra içindeki her JS dosyası çözülür.
// Kullanım: peel-node <girdi> [-o çıktı.js | -d çıktı-dizini] [--report rapor.json] ... | peel-node <alt komut> ...  (--help)
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
