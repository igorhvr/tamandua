// Creates a stray file in node_modules/ during each test run.
// This is a load-bearing junk probe for the tamandua torture test suite.
// The file is regenerated on every run; oracles verify it exists + is untracked.

import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const nodeModules = join(import.meta.dirname, '..', 'node_modules');
const strayFile = join(nodeModules, '.tamandua-stray-probe.txt');

if (existsSync(nodeModules)) {
  writeFileSync(strayFile, `Tamandua torture test stray probe file.\nGenerated at: ${new Date().toISOString()}\n`);
}
