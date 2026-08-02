import { spawnSync } from 'node:child_process';

import { OracleRuntimeError, requireContainedPath } from './paths.mjs';

const READ_ONLY_COMMANDS = new Set([
  'cat-file', 'diff-tree', 'for-each-ref', 'log', 'ls-tree', 'merge-base',
  'name-rev', 'patch-id', 'rev-list', 'rev-parse', 'show', 'show-ref',
]);
const GIT_BINARY = '/usr/bin/git';
const UNSAFE_ARGUMENTS = new Set([
  '-c', '-C', '--config-env', '--exec-path', '--git-dir', '--work-tree',
  '--namespace', '--super-prefix', '--upload-pack', '--receive-pack',
  '--output', '--ext-diff', '--textconv',
]);

export function runGit({ campaignRoot, repository, args, timeout = 5000, input, acceptedStatuses = [0] }) {
  if (!Array.isArray(args) || args.length === 0 || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new OracleRuntimeError('git args must be a nonempty array of safe strings');
  }
  if (args.some((arg) => UNSAFE_ARGUMENTS.has(arg)
      || [...UNSAFE_ARGUMENTS].some((option) => option.startsWith('--') && arg.startsWith(`${option}=`))
      || (arg.startsWith('-') && (arg.includes('signature') || arg === '--filters' || arg.startsWith('--filters=')))
      || arg.includes('%(signature') || arg.includes('%G'))) {
    throw new OracleRuntimeError('unsafe git configuration or executable override argument');
  }
  if (!READ_ONLY_COMMANDS.has(args[0])) throw new OracleRuntimeError(`git command ${args[0]} is not allowlisted read-only plumbing`);
  const cwd = requireContainedPath(campaignRoot, repository, { kind: 'directory', label: 'git repository' });
  if (input !== undefined && typeof input !== 'string') throw new OracleRuntimeError('git input must be a string');
  if (!Array.isArray(acceptedStatuses) || acceptedStatuses.length === 0
      || acceptedStatuses.some((status) => !Number.isInteger(status) || status < 0)) {
    throw new OracleRuntimeError('accepted git statuses must be non-negative integers');
  }
  const result = spawnSync(GIT_BINARY, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    input,
    env: {
      PATH: process.env.PATH,
      HOME: campaignRoot,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG: '/dev/null',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1',
      GIT_PROTOCOL_FROM_USER: '0',
      GIT_ALLOW_PROTOCOL: '',
      GIT_PAGER: 'cat',
      GIT_EXTERNAL_DIFF: '',
      XDG_CONFIG_HOME: campaignRoot,
      PAGER: 'cat',
      LC_ALL: 'C',
    },
  });
  if (result.error !== undefined) throw new OracleRuntimeError(`git execution failed: ${result.error.message}`);
  if (result.signal !== null) throw new OracleRuntimeError(`git terminated by signal ${result.signal}`);
  if (!acceptedStatuses.includes(result.status)) throw new OracleRuntimeError(`git exited ${result.status}: ${(result.stderr ?? '').trim()}`);
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}
