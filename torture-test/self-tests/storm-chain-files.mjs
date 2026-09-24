#!/usr/bin/env node
// storm-chain-files.mjs — print the canonical 49-file storm chain selection
// (run #7 `chain-files.txt` order) to stdout. Used by the chain wrapper to
// materialize the retained `chain-files.txt`.

import { renderChainFileList } from "./storm-chain-report.mjs";

process.stdout.write(renderChainFileList());
