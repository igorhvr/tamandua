# Portability

Tamandua targets three environments for shell commands: GNU/Linux with GNU findutils, macOS with BSD find, and systems where `find` is [bfs](https://github.com/tahimikimbo/bfs) (a breadth-first `find` that some users alias). All scripts, TypeScript spawns, and agent instructions must use only constructs supported by all three implementations.

## Portable `find` Usage

### Target Implementations

| Implementation | Typical platform | Notes |
|---|---|---|
| GNU findutils | Linux | The most feature-rich; avoid GNU-only extensions |
| BSD/macOS find | macOS | Ships with the OS; fewer flags than GNU find |
| bfs | User-installed, aliased to `find` | Breadth-first; rejects many GNU-isms (e.g. natural-language timestamps) |

### Banned Constructs

These flags are NOT portable across all three implementations. Use the alternatives listed below.

| Banned flag | Problem | Portable alternative |
|---|---|---|
| `-newermt '<natural language>'` | bfs rejects natural-language timestamps silently (no output, no error with stderr suppressed) | `-mmin -N` / `-mmin +N` for age-based filtering; `touch -t YYYYMMDDhhmm.ss ref && find ... -newer ref` for exact reference timestamps |
| `-printf` | GNU-only formatting directive | `-exec printf '%s\n' {} \;` or post-process with `stat` (branch on OS if needed) |
| `-regextype` | GNU/bfs only; BSD find doesn't support regex type selection | Use `-name`/`-path` globs instead of regex; if regex is unavoidable, use `grep -E` on find output |
| `-mindepth` | Available on GNU and bfs, but NOT on BSD/macOS find | Filter by depth manually (e.g., `find ... | awk -F/ 'NF > N'`) or restructure the search path |
| `-daystart` | GNU-only time-base modifier | Use `-mtime` with explicit ranges |
| `-amin` | GNU-only (access time in minutes) | Use `-mmin` instead (modification time is more reliable and portable); or use `find ... -newer ref` with a `touch`-created reference |
| `-cmin` | GNU-only (status change time in minutes) | Use `-mmin` instead; status-change time is rarely the right semantic for portability |
| `-used` | GNU-only (last access after status change) | Use `-atime`/`-mtime` instead, or `find ... -newer ref` |
| `-fstype` | GNU/BSD only (bfs does not support it) | Filter by mount point with `df`/`mount` output, or restructure to avoid crossing filesystem boundaries |
| `-wholename` | GNU-only alias for `-path` | Use `-path` instead (supported by all three implementations) |

### Allowed Portable Constructs

These flags and operators are safe across GNU find, BSD/macOS find, and bfs:

| Construct | Description |
|---|---|
| `-maxdepth N` | Limit directory traversal depth |
| `-print0` | Null-terminated output (safe for `xargs -0`) |
| `-type f` / `-type d` / `-type l` | Filter by file type |
| `-name 'pattern'` | Match basename against glob |
| `-path 'pattern'` | Match full path against glob |
| `! expr` or `-not expr` | Negation (`!` is the most portable; `-not` is also fine) |
| `-prune` | Stop descending into matching directories |
| `-mmin -N` / `-mmin +N` | Modified N minutes ago (minutes; all three support this) |
| `-mtime -N` / `-mtime +N` | Modified N days ago (truncated to 24h periods; all three support this) |
| `-newer ref` | Modified more recently than reference file |
| `-newerXY ref` | Timestamp comparison (GNU-only; avoid) |
| `-exec ... {} +` / `-exec ... {} \;` | Execute command on matches |
| `-delete` | Delete matching files (GNU and bfs; BSD supports it since macOS 10.9) |

### Alias Safety

Shell scripts executed non-interactively by Tamandua (daemon-spawned subprocesses) run with aliases disabled by default, so `find` resolves to the actual binary on `$PATH`. However, documentation and agent instructions that users or agents copy-paste should recommend `command find` or an explicit path (`/usr/bin/find`) to guard against shell aliases.

### Reference Timestamp Pattern

When you need an exact reference timestamp (not just "modified within the last N minutes"):

```bash
# Create a reference file with a specific timestamp (POSIX, works everywhere)
touch -t 202607100900.00 /tmp/ref-stamp

# Find files newer than that reference
find . -type f -newer /tmp/ref-stamp

# Clean up
rm -f /tmp/ref-stamp
```

For "modified in the last N minutes/hours/days," always prefer `-mmin` or `-mtime`:

```bash
# Files modified in the last 3 hours
find . -type f -mmin -180

# Files NOT modified in the last 7 days
find . -type f -mtime +7
```

## Enforcement

The portability-lint test suite (`tests/portability-lint.test.ts`) scans all tracked shell scripts (`.sh`), TypeScript files (`.ts`), and JavaScript modules (`.mjs`) under `src/`, `scripts/`, `tests/`, and `e2e-tests/` for banned find patterns. Every banned flag listed above is checked.

A file-level exception mechanism (`FIND_FLAG_ALLOWED`) exists for justified cases where a banned flag is unavoidable — the exception entry must include a comment documenting why the exception is necessary. The repository-level test asserts zero violations across the entire codebase, so any new non-portable find usage fails the build.

Run it with:

```bash
npm test
```

The portability-lint tests are part of the standard test suite and run on every invocation.
