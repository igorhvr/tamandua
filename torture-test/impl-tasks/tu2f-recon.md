# TU2F — US-001 Recon: audit/bead sources & torture-tree ignore baseline

Run: run-c13d1de8-be66-40eb-80f3-f88e66b5083d
Story: US-001 — Locate audit/bead sources and capture the torture-tree ignore baseline
Date: 2026-09-18 (VM clock)
Branch: feature/tu2f-torture-union-leftovers-nf6
Base: 0f305702 feat: NPF-2 scripted suite-ledger evidence and O12 content pin

## 1. Host-path / source visibility (VM facts)

This round executes inside a Matchlock VM. The following host paths were probed and
are **absent** inside the VM:

| Source | Path | Visible in VM? |
|--------|------|----------------|
| TORTURE-UNION-2 audit report | `/home/kaladin/vaivm-archive/vaivm-audit/report.md` | **NO** (`No such file or directory`) |
| NPF-2 fixture contract | `/home/kaladin/matchlock-work/npf2-fixture-contract.json` | **NO** (`No such file or directory`) |
| Gate lock path | `/home/kaladin/matchlock-work/vaivm-gate.lock` | **NO** (parent dir absent) |
| bead tamandua-6sy.68 | `bd` CLI | **NO** (`bd: command not found`) |

Because the audit report is not visible, the NF-1..NF-6 content was reconstructed
from the task input, the Story Plan (pre-populated in progress.txt), and direct
tree analysis. The bead text for `tamandua-6sy.68` is not reachable from the VM
(no `bd` binary, no `.beads` issues export visible on PATH). The repo's `.beads/`
directory is present at the checkout root but carries no `bd` tooling.

## 2. Full torture-tree .gitignore inventory

`git ls-files 'torture-test/**/.gitignore'` returns **15 tracked files**:

1. `torture-test/.gitignore` — runtime containment: `var/` (line 4)
2. `torture-test/fixtures-src/tt-go/.gitignore`
3. `torture-test/fixtures-src/tt-java/.gitignore`
4. `torture-test/fixtures-src/tt-poly/.gitignore`
5. `torture-test/fixtures-src/tt-poly/go/.gitignore`
6. `torture-test/fixtures-src/tt-poly/java/.gitignore`
7. `torture-test/fixtures-src/tt-poly/python/.gitignore`
8. `torture-test/fixtures-src/tt-poly/rust/.gitignore`
9. `torture-test/fixtures-src/tt-poly/ts/.gitignore`
10. `torture-test/fixtures-src/tt-poly-lite/.gitignore`
11. `torture-test/fixtures-src/tt-poly-lite/python/.gitignore`
12. `torture-test/fixtures-src/tt-poly-lite/ts/.gitignore`
13. `torture-test/fixtures-src/tt-python/.gitignore`
14. `torture-test/fixtures-src/tt-rust/.gitignore`
15. `torture-test/fixtures-src/tt-ts/.gitignore`

### Effective patterns per file

| File | Effective patterns |
|------|--------------------|
| `torture-test/.gitignore` | `var/` |
| `fixtures-src/tt-go/.gitignore` | `.idea/`, `.vscode/`, `.DS_Store` |
| `fixtures-src/tt-java/.gitignore` | `.mvn/wrapper/maven-wrapper.jar` |
| `fixtures-src/tt-poly/.gitignore` | `.venv/`, `*.egg-info/`, `dist/`, `build/`, `.mypy_cache/` |
| `fixtures-src/tt-poly/go/.gitignore` | *(none — comments only)* |
| `fixtures-src/tt-poly/java/.gitignore` | *(none — comments only)* |
| `fixtures-src/tt-poly/rust/.gitignore` | *(none — comments only)* |
| `fixtures-src/tt-poly/python/.gitignore` | `.venv/`, `*.egg-info/`, `dist/`, `build/` |
| `fixtures-src/tt-poly/ts/.gitignore` | `dist/` |
| `fixtures-src/tt-poly-lite/.gitignore` | `.venv/`, `*.egg-info/`, `dist/`, `build/`, `.mypy_cache/` |
| `fixtures-src/tt-poly-lite/python/.gitignore` | `.venv/`, `*.egg-info/`, `dist/`, `build/` |
| `fixtures-src/tt-poly-lite/ts/.gitignore` | `dist/` |
| `fixtures-src/tt-python/.gitignore` | `.venv/`, `*.egg-info/`, `dist/`, `build/` |
| `fixtures-src/tt-rust/.gitignore` | `.idea/`, `.vscode/`, `.DS_Store` |
| `fixtures-src/tt-ts/.gitignore` | `dist/` |

## 3. Baseline ignore behaviour for runtime-output paths

All runtime output lives under `torture-test/var/`, which is contained by the
single top-level rule `torture-test/.gitignore:4:var/`. `torture-test/var/`
currently contains one **tracked** file (`var/baseline-failures.txt`) and no
untracked ignored files (the tree is clean), so `git status --ignored` is empty.

### Baseline `git check-ignore -v`

```
$ git check-ignore -v torture-test/var/foo.txt
torture-test/.gitignore:4:var/	torture-test/var/foo.txt

$ git check-ignore -v torture-test/var/results/
torture-test/.gitignore:4:var/	torture-test/var/results/

$ git check-ignore -v torture-test/var/results/bar.json
torture-test/.gitignore:4:var/	torture-test/var/results/bar.json

$ git check-ignore -v torture-test/var/evidence/
torture-test/.gitignore:4:var/	torture-test/var/evidence/

$ git check-ignore -v torture-test/var/evidence/blob.bin
torture-test/.gitignore:4:var/	torture-test/var/evidence/blob.bin
```

Note on the bare directory path: `git check-ignore -v torture-test/var` (and the
trailing-slash form `torture-test/var/`) return no match (exit 1). This is a git
`check-ignore` quirk — it does not report a directory-only pattern against the
directory pathname itself. The canonical proof for `var/` containment is therefore
a path *inside* `var/` (e.g. `torture-test/var/foo.txt` above), which resolves to
`torture-test/.gitignore:4:var/`. The US-002 proof should use in-`var/` paths.

### Baseline `git status --ignored --short torture-test/`

```
(empty — no untracked ignored files present; tree is clean)
```

## 4. NF-6 candidate .gitignore(s)

The redundancy is in the `tt-poly*` fixture subtrees. The parent `.gitignore`
already declares `.venv/`, `*.egg-info/`, `dist/`, `build/`; because those
patterns are **unanchored** (no leading `/`), git applies them at every depth
below the parent directory. The nested `.gitignore` files therefore re-declare
rules that are already effective, and two nested `dist/` files and the three
comment-only `go`/`java`/`rust` files add no effective patterns at all.

### Candidate A — nested re-declarations of parent rules

| Nested file | Duplicated rules | Covered by parent |
|-------------|------------------|-------------------|
| `fixtures-src/tt-poly/python/.gitignore` | `.venv/`, `*.egg-info/`, `dist/`, `build/` | `fixtures-src/tt-poly/.gitignore` |
| `fixtures-src/tt-poly/ts/.gitignore` | `dist/` | `fixtures-src/tt-poly/.gitignore` |
| `fixtures-src/tt-poly-lite/python/.gitignore` | `.venv/`, `*.egg-info/`, `dist/`, `build/` | `fixtures-src/tt-poly-lite/.gitignore` |
| `fixtures-src/tt-poly-lite/ts/.gitignore` | `dist/` | `fixtures-src/tt-poly-lite/.gitignore` |

Per-file evidence (current resolution is the nested file, but behaviour is
identical if the nested rule is removed because the parent rule still matches):

```
$ git check-ignore -v torture-test/fixtures-src/tt-poly/python/.venv/x
torture-test/fixtures-src/tt-poly/python/.gitignore:2:.venv/	torture-test/fixtures-src/tt-poly/python/.venv/x

$ git check-ignore -v torture-test/fixtures-src/tt-poly/python/build/x
torture-test/fixtures-src/tt-poly/python/.gitignore:17:build/	torture-test/fixtures-src/tt-poly/python/build/x

$ git check-ignore -v torture-test/fixtures-src/tt-poly-lite/python/.venv/x
torture-test/fixtures-src/tt-poly-lite/python/.gitignore:2:.venv/	torture-test/fixtures-src/tt-poly-lite/python/.venv/x

$ git check-ignore -v torture-test/fixtures-src/tt-poly-lite/python/dist/x
torture-test/fixtures-src/tt-poly-lite/python/.gitignore:13:dist/	torture-test/fixtures-src/tt-poly-lite/python/dist/x

$ git check-ignore -v torture-test/fixtures-src/tt-poly/ts/dist/x
torture-test/fixtures-src/tt-poly/ts/.gitignore:2:dist/	torture-test/fixtures-src/tt-poly/ts/dist/x

$ git check-ignore -v torture-test/fixtures-src/tt-poly-lite/ts/dist/x
torture-test/fixtures-src/tt-poly-lite/ts/.gitignore:2:dist/	torture-test/fixtures-src/tt-poly-lite/ts/dist/x
```

### Candidate B — comment-only nested files with no effective patterns

| File | Effective patterns |
|------|--------------------|
| `fixtures-src/tt-poly/go/.gitignore` | none (only "deliberately NOT gitignored" JUNK notes) |
| `fixtures-src/tt-poly/java/.gitignore` | none (only "target/ NOT gitignored" JUNK note) |
| `fixtures-src/tt-poly/rust/.gitignore` | none (only "target/ NOT gitignored" JUNK note) |

These three carry only "deliberately NOT gitignored" documentation. The
documentation is load-bearing (it explains which paths are intentional junk
probes) and must be preserved if these files are consolidated — see the
`JUNK-IS-INTENTIONAL.md` / `README-JUNK.md` references and the US-002 notes.

### Non-candidates (must NOT be touched)

- `torture-test/.gitignore` — its single `var/` rule is the runtime containment
  story and is **not** redundant.
- The standalone fixture `.gitignore` files (`tt-go`, `tt-java`, `tt-python`,
  `tt-rust`, `tt-ts`) each have effective patterns and are not duplicated by any
  ancestor (their nearest ancestors are `fixtures-src/` and the repo root, which
  declare nothing relevant).

## 5. Acceptance criteria check for US-001

- [x] Recon file is tracked under `torture-test/` (`torture-test/impl-tasks/tu2f-recon.md`)
- [x] Records audit/bead path visibility (section 1)
- [x] Full torture-tree `.gitignore` inventory (section 2)
- [x] Baseline `git check-ignore -v` for `var/`, `var/results/`, `var/evidence/` (section 3)
- [x] Names NF-6 candidate(s) with per-file evidence (section 4)
- [x] No `.gitignore` modified in this story (recon only; verified via `git status` below)
- [x] No file outside `torture-test/` modified
