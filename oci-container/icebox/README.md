# icebox image layer (Pillar A + Pillar B) — recipe + verification

This directory holds the ICEBOX image-layer changes (design v6 §2 + §3) and
their verification tooling. It is consumed by `oci-container/Dockerfile`.

## Layout

    pillar-a/           the layer payload + the ONE installer used to apply it
      apply.sh          idempotent, fail-closed installer (build + acceptance share it)
      zshenv.append     /etc/zsh/zshenv fragment (nix PATH; wizard suppression; skip_global_compinit)
      zshrc.append      /etc/zsh/zshrc fragment (system-wide oh-my-zsh loader; ~/.local/bin guard)
      nix-path.sh       /etc/profile.d drop-in for sh/bash login shells (mode 644)
      screenrc.block    operator screen block appended to /etc/screenrc
      90-tamandua-guest /etc/sudoers.d drop-in (mode 440, visudo-checked)
      nix.conf          /etc/nix/nix.conf (experimental-features = nix-command flakes)
    verify-icebox-env.sh  HOST driver: builds --target icebox-env, runs the matrix in a container
    verify-matrix.sh      in-container acceptance matrix (as-built asserts + idempotence rerun)

## Build the env-only stage (pinned base + this layer, no product stages)

    docker build --target icebox-env -t tamandua-icebox-env:local oci-container

## Run the acceptance suite (disposable container)

    oci-container/icebox/verify-icebox-env.sh [image-tag] [logfile]
    # KEEP=1 keeps the container on exit for inspection

The matrix asserts, as BOTH uid 1000 and uid 501 with fresh homes: wizard-free
first interactive shell; empty `~/.zshrc` created only for interactive shells
(ZDOTDIR respected, never overwritten, no-touch on existing); oh-my-zsh loads
from `/usr/share/oh-my-zsh` with zero errors and `/usr/share` (whole tree)
stays unwritten; nix on PATH for interactive zsh, non-interactive zsh, and
sh/bash login shells; `sudo -n` works with nix FIRST in secure_path (plus
`--no-new-privs` refusal control and an absent-uid control); screen block
applies (shell, scrollback, escape, hardstatus); visudo parses the drop-in.
It then reruns the installer and asserts byte-identical idempotence.

## Design notes / deliberate deviations

- **screen ordering (FLAGGED DEVIATION — needs disposition)**: design v6 §2
  pairs "append the operator block" with "stock Debian file remains below" —
  two conflicting clauses. Implemented as the only functionally effective
  reading: the operator block is APPENDED AFTER the stock file (so the stock
  file ends up ABOVE the block). Screen applies later directives over earlier
  ones, so block-last yields the operator behavior for the settings the stock
  file also touches: the matrix measures a rendered status bar and 5026
  retained scrollback lines (block-last), a stock-only control retained ~1048
  lines, and the block-first variant showed no status bar. The stock file
  carries no `shell` directive, so `shell /bin/zsh` is not order-dependent;
  under block-first the operator hardstatus/scrollback settings would be
  overridden by the stock tail. The design-era harness
  (ICEBOX-EVIDENCE-20261010/icebox-final-check.sh) also appends the block last.
  Flagged for orchestrator disposition; if literal stock-below placement is
  required it is a one-line cat-order change plus a matrix update, at the cost
  of the operator hardstatus/scrollback settings being overridden.
- **compinit shim**: the bundled oh-my-zsh calls a bare `compinit -i`, which
  still runs the insecure-directory scan and ignores `ZSH_COMPDUMP`. The
  loader intercepts that one call with a self-removing function that runs
  `compinit -C -d "$ZSH_COMPDUMP"` (no scan; per-user dumpfile). Caveat with
  `-C`: an EXISTING dumpfile is trusted as-is (no version/file-count
  revalidation); delete the effective dumpfile (`${ZDOTDIR:-$HOME}/.zcompdump`)
  to force a rebuild. After the call the
  real compinit's tail restores the autoload stub, so later manual re-sources
  behave stock.
- **screenrc.block trailing blank line**: the fragment is byte-identical to
  the base `/root/.screenrc`, so it ends with a trailing blank line;
  `git diff --check` flags it as the sole justified whitespace exception. Do
  not trim it — the installer's byte-equality guard and the matrix tail
  comparison run against these exact bytes.
- **base limitations**: uid 501 has no passwd entry in the base (the matrix
  creates a prep-style entry, as tamandua's interactive prep does in-VM); sudo
  requires a resolvable passwd identity — an absent uid (no passwd entry)
  cannot `sudo` even with a permissive rule, which is expected behavior,
  covered by a control cell. The Nix store is single-user (root-owned); the
  matrix verifies PATH/config/elevated nix execution, NOT ordinary-user store
  writes (a non-root `nix eval` cannot take the store lock).
