#!/usr/bin/env bash
# Icebox image-layer installer — Pillar A (Tier-A environment) + Pillar B
# (passwordless-sudo drop-in). ONE installer path, used by both the image build
# (Dockerfile `icebox-env` stage) and the disposable-container acceptance run
# (oci-container/icebox/verify-icebox-env.sh re-runs it inside the built stage).
#
# Installs, idempotently and fail-closed:
#   /etc/zsh/zshenv append               nix PATH guard; wizard suppression (both
#                                        mechanisms); skip_global_compinit=1
#   /etc/zsh/zshrc append                system-wide oh-my-zsh loader (user's own
#                                        ~/.oh-my-zsh wins; root untouched; per-user
#                                        compdump + cache dir; no insecure-dir scan);
#                                        ~/.local/bin PATH guard
#   /etc/profile.d/nix-path.sh           nix PATH for sh/bash login shells (644)
#   /usr/share/oh-my-zsh                 byte-identical, world-readable copy of
#                                        /root/.oh-my-zsh (validated: diff clean,
#                                        root-owned, no group/world write bits)
#   /etc/screenrc                        operator block appended AFTER the stock
#                                        Debian file — later screenrc directives
#                                        win where they conflict, so the block
#                                        MUST come last for the operator
#                                        escape/hardstatus/scrollback/shell
#                                        settings to take effect
#   /etc/sudoers.d/90-tamandua-guest     passwordless sudo for all users;
#                                        secure_path with the nix profile bin
#                                        FIRST; mode 440; visudo-checked here
#   /etc/nix/nix.conf                    experimental-features = nix-command flakes
#
# The image Dockerfile ALSO prepends /nix/var/nix/profiles/default/bin to PATH
# via `ENV PATH=...` in the icebox-env stage, so interactive sessions and every
# child process (pi/hermes/...) see nix, uv and yggdrasil without any shell rc.
#
# Idempotence / drift policy: the zsh and screenrc fragments are recognized by
# an EXACT byte match of the file tail against the shipped fragment. A file
# that contains icebox markers but does NOT end in the exact shipped bytes is
# DRIFT and fails the build (rebuild from a clean base; never blind-append).
#
# Prerequisites in the base are DETECTED here and fail closed with a precise
# message when absent (never silently skipped): /root/.oh-my-zsh,
# /root/.screenrc (byte-checked against the pinned block), zsh, visudo, /etc/zsh.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
say() { printf 'icebox: %s\n' "$*"; }
die() { printf 'icebox: FATAL: %s\n' "$*" >&2; exit 1; }

# ---- 0. prerequisites (fail closed, precise) --------------------------------
for f in zshenv.append zshrc.append nix-path.sh 90-tamandua-guest nix.conf screenrc.block; do
  [ -r "$HERE/$f" ] || die "missing asset: $HERE/$f"
done
[ -d /etc/zsh ]          || die "base lacks /etc/zsh (zsh not installed?)"
[ -s /etc/zsh/zshenv ]   || die "base /etc/zsh/zshenv missing or empty"
[ -s /etc/zsh/zshrc ]    || die "base /etc/zsh/zshrc missing or empty"
[ -s /etc/screenrc ]     || die "base /etc/screenrc missing or empty"
command -v zsh >/dev/null 2>&1    || die "base lacks zsh"
command -v visudo >/dev/null 2>&1 || die "base lacks visudo"
[ -d /root/.oh-my-zsh ]  || die "base lacks /root/.oh-my-zsh (needed for the /usr/share/oh-my-zsh copy)"
[ -f /root/.screenrc ]   || die "base lacks /root/.screenrc (needed for the /etc/screenrc operator block)"
cmp -s "$HERE/screenrc.block" /root/.screenrc \
  || die "base /root/.screenrc differs from the pinned screenrc.block (base drift; re-pin deliberately, do not blind-append)"

# ---- helpers ----------------------------------------------------------------
# tail_matches FILE FRAGMENT: true when FILE ends with exactly FRAGMENT's bytes.
tail_matches() {
  local file="$1" frag="$2" n
  n=$(wc -c < "$frag")
  [ "$(wc -c < "$file")" -ge "$n" ] || return 1
  cmp -s <(tail -c "$n" "$file") "$frag"
}

# ---- 1. /etc/zsh fragments (append, once; exact-tail drift check) -----------
for pair in "zshenv" "zshrc"; do
  target="/etc/zsh/$pair"
  frag="$HERE/$pair.append"
  if tail_matches "$target" "$frag"; then
    say "$pair fragment already present, exact match (idempotent skip)"
  elif grep -q 'tamandua icebox' "$target"; then
    die "$pair contains icebox markers but not the exact shipped fragment tail: DRIFT -- rebuild from a clean base"
  else
    cat "$frag" >> "$target"
    say "appended $pair fragment"
  fi
done
zsh -n /etc/zsh/zshenv || die "/etc/zsh/zshenv fails the zsh syntax check"
zsh -n /etc/zsh/zshrc  || die "/etc/zsh/zshrc fails the zsh syntax check"

# ---- 2. /etc/profile.d (sh/bash login shells) -------------------------------
install -m 644 "$HERE/nix-path.sh" /etc/profile.d/nix-path.sh
say "installed /etc/profile.d/nix-path.sh (644)"

# ---- 3. /usr/share/oh-my-zsh (byte-identical, world-readable, root-owned) ---
rm -rf /usr/share/oh-my-zsh
cp -a /root/.oh-my-zsh /usr/share/oh-my-zsh
chmod -R a+rX /usr/share/oh-my-zsh
diff -r -q /root/.oh-my-zsh /usr/share/oh-my-zsh >/dev/null \
  || die "the /usr/share/oh-my-zsh copy is not byte-identical to /root/.oh-my-zsh"
[ -z "$(find /usr/share/oh-my-zsh ! -user root -print -quit)" ] \
  || die "/usr/share/oh-my-zsh contains files not owned by root"
[ -z "$(find /usr/share/oh-my-zsh \( -perm -g+w -o -perm -o+w \) -print -quit)" ] \
  || die "/usr/share/oh-my-zsh contains group/world-writable entries"
say "installed /usr/share/oh-my-zsh (byte-identical copy, root-owned, no g/o write bits)"

# ---- 4. /etc/screenrc (operator block appended AFTER the stock file) --------
if tail_matches /etc/screenrc "$HERE/screenrc.block"; then
  say "screen block already present, exact match (idempotent skip)"
elif grep -qF 'defscrollback 8196' /etc/screenrc; then
  die "/etc/screenrc carries a screen block that is not the exact shipped block: DRIFT -- rebuild from a clean base"
elif grep -qF 'defscrollback 1024' /etc/screenrc; then
  cat "$HERE/screenrc.block" >> /etc/screenrc
  say "appended operator screen block to /etc/screenrc (stock file remains above it)"
else
  die "/etc/screenrc is neither the stock Debian file nor the shipped block: unrecognized content"
fi

# ---- 5. sudoers drop-in (Pillar B; visudo-checked here) ---------------------
install -m 440 "$HERE/90-tamandua-guest" /etc/sudoers.d/90-tamandua-guest
[ "$(stat -c %a /etc/sudoers.d/90-tamandua-guest)" = "440" ] || die "sudoers drop-in mode is not 440"
visudo -cf /etc/sudoers.d/90-tamandua-guest || die "visudo rejected /etc/sudoers.d/90-tamandua-guest"
visudo -c                                  || die "visudo rejected the full sudoers configuration"
say "installed /etc/sudoers.d/90-tamandua-guest (mode 440, visudo-checked)"

# ---- 6. /etc/nix/nix.conf (completeness b) ----------------------------------
install -d -m 755 /etc/nix
install -m 644 "$HERE/nix.conf" /etc/nix/nix.conf
say "installed /etc/nix/nix.conf (644)"

say "Pillar A + Pillar B layer complete"
