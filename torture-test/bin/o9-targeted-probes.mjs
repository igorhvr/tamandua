#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SHIM = path.resolve(TT_ROOT, '..', 'bin', 'tamandua-test');
const PROBE_PATH = '.git/tamandua-o9-junk-probe';

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', shell: false, timeout: 10_000,
  });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr?.trim() ?? result.signal ?? `exit ${result.status}`}`);
  }
  return result.stdout;
}

function parseArgs(argv) {
  const options = { repo: null, runId: null, stepPrefix: 'o9-special', shim: DEFAULT_SHIM };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--repo', '--run', '--step-prefix', '--shim'].includes(argument) || index + 1 >= argv.length) {
      throw new Error(`invalid argument: ${argument}`);
    }
    const value = argv[++index];
    if (argument === '--repo') options.repo = value;
    else if (argument === '--run') options.runId = value;
    else if (argument === '--step-prefix') options.stepPrefix = value;
    else options.shim = value;
  }
  if (options.repo === null || options.runId === null) throw new Error('--repo and --run are required');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.stepPrefix)) throw new Error('--step-prefix is invalid');
  return options;
}

function validateContained(candidate, root, label, executable = false) {
  const rootReal = fs.realpathSync(root);
  const details = fs.lstatSync(candidate);
  const real = fs.realpathSync(candidate);
  const relative = path.relative(rootReal, real);
  if ((executable ? !details.isFile() : !details.isDirectory()) || details.isSymbolicLink()
      || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} is not contained beneath torture-test state`);
  }
  if (executable) fs.accessSync(real, fs.constants.X_OK);
  return real;
}

function writeExecutable(file, content) {
  fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o700, flag: 'wx' });
}

function invokeShim(shim, repo, runId, stepId, command, env, interrupt = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(shim, ['--repo', repo, '--run', runId, '--step', stepId, '--force', '--', command], {
      cwd: repo,
      env: { ...env, TAMANDUA_TSTX_JUNK_PROBE: PROBE_PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let signaled = false;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`targeted O9 probe ${stepId} timed out; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`));
    }, 8_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (interrupt && !signaled && stdout.includes('O9 INTERRUPT READY')) {
        signaled = true;
        child.kill('SIGTERM');
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ exitCode: code, signal, stdout, stderr });
    });
  });
}

export async function runO9TargetedProbes(rawOptions) {
  const repo = validateContained(rawOptions.repo, TT_ROOT, 'fixture repository');
  const shim = validateContained(rawOptions.shim ?? DEFAULT_SHIM, path.resolve(TT_ROOT, '..'), 'tamandua-test shim', true);
  const runId = String(rawOptions.runId);
  const stepPrefix = String(rawOptions.stepPrefix ?? 'o9-special');
  if (!/^run-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) throw new Error('run ID is invalid');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(stepPrefix)) throw new Error('step prefix is invalid');
  const gitDir = path.join(repo, '.git');
  if (!fs.lstatSync(gitDir).isDirectory()) throw new Error('targeted O9 probes require a contained ordinary fixture checkout');
  if (run('git', ['status', '--porcelain', '--untracked-files=no'], repo).trim() !== '') {
    throw new Error('targeted O9 probes require a clean tracked fixture worktree');
  }
  const tracked = run('git', ['ls-files', '-z'], repo).split('\0')
    .find((entry) => entry !== '' && fs.statSync(path.join(repo, entry)).isFile());
  if (tracked === undefined) throw new Error('targeted O9 probes require one tracked regular file');

  const workRoot = path.join(TT_ROOT, 'var', 'o9-targeted-probes');
  fs.mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  const workDir = path.join(workRoot, `${stepPrefix}-${process.pid}`);
  fs.mkdirSync(workDir, { recursive: false, mode: 0o700 });
  const target = path.join(repo, tracked);
  const original = fs.readFileSync(target);
  const originalMode = fs.statSync(target).mode;
  const junkProbe = path.join(repo, PROBE_PATH);
  fs.writeFileSync(junkProbe, 'controller-authored O9 junk probe\n', { encoding: 'utf8', mode: 0o600 });
  const driftScript = path.join(workDir, 'exit-86.sh');
  const interruptScript = path.join(workDir, 'exit-87.sh');
  const cleanScript = path.join(workDir, 'exit-88.sh');
  writeExecutable(driftScript, `#!/bin/sh\nprintf '\\nO9 TARGETED DRIFT\\n' >> ${shellQuote(target)}\n`);
  writeExecutable(interruptScript, "#!/bin/sh\ntrap 'exit 99' TERM INT\nprintf 'O9 INTERRUPT READY\\n'\nwhile :; do sleep 1; done\n");
  writeExecutable(cleanScript, '#!/bin/sh\nexit 0\n');

  const results = [];
  try {
    results.push(await invokeShim(shim, repo, runId, `${stepPrefix}-86`, shellQuote(driftScript), rawOptions.env ?? process.env));
    fs.writeFileSync(target, original, { mode: originalMode });
    results.push(await invokeShim(shim, repo, runId, `${stepPrefix}-87`, shellQuote(interruptScript), rawOptions.env ?? process.env, true));
    fs.writeFileSync(target, Buffer.concat([original, Buffer.from('\nO9 TARGETED PRE-DIRTY\n')]), { mode: originalMode });
    results.push(await invokeShim(shim, repo, runId, `${stepPrefix}-88`, shellQuote(cleanScript), rawOptions.env ?? process.env));
  } finally {
    fs.writeFileSync(target, original, { mode: originalMode });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  const exits = results.map((result) => result.exitCode);
  if (JSON.stringify(exits) !== JSON.stringify([86, 87, 88])) {
    throw new Error(`targeted O9 probes returned ${JSON.stringify(exits)} instead of [86,87,88]`);
  }
  const trackedProbe = spawnSync('git', ['ls-files', '--error-unmatch', '--', PROBE_PATH], {
    cwd: repo, stdio: 'ignore', shell: false,
  }).status === 0;
  if (trackedProbe) throw new Error('targeted O9 junk probe became tracked');
  return { schema_version: 1, run_id: runId, step_prefix: stepPrefix, exits, junk_probe_path: PROBE_PATH, junk_probe_tracked: false };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runO9TargetedProbes({ ...parseArgs(process.argv.slice(2)), env: process.env })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`o9-targeted-probes: ${error.message}\n`);
      process.exitCode = 1;
    });
}
