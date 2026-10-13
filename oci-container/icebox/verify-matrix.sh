#!/usr/bin/env bash
# icebox env-stage acceptance matrix. Runs INSIDE a disposable container built
# from the Dockerfile `icebox-env` stage (pinned base + Pillar A/B layer) and
# asserts the AS-BUILT state FIRST; the idempotence rerun of the installer is
# the LAST section (after the /usr/share no-write observation window closes).
# Exit 0 only when every assertion passes.
#
# Host driver: oci-container/icebox/verify-icebox-env.sh
set -u -o pipefail
M=/opt/icebox/pillar-a
X=/tmp/mx
FP_ERR="$X/fp.err"
FAIL=0; PASS=0
ok(){ echo "  ok: $*"; PASS=$((PASS+1)); }
bad(){ echo "  FAIL: $*"; FAIL=1; }
sec(){ echo; echo "== $*"; }
eq(){ if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (got [$1] want [$2])"; fi; }
has(){ if printf '%s' "$2" | grep -q -- "$1"; then ok "$3"; else bad "$3 (no match [$1] in [$2])"; fi; }
hasnt(){ if printf '%s' "$2" | grep -q -- "$1"; then bad "$3 (unexpected [$1] in [$2])"; else ok "$3"; fi; }
need(){ [ -e "$1" ] || { bad "$2 (missing: $1)"; return 1; }; }

# Byte prefixes + digests of the pinned base's stock files. Update ONLY with a
# deliberate base-digest bump.
STOCK_ZHENV_BYTES=623;  STOCK_ZHENV_SHA=a01e6479dc788f17d26eedd7d32bbb6843400a6bba0fc840bdc0e9cf89030d66
STOCK_ZHRC_BYTES=3900;  STOCK_ZHRC_SHA=b5204b4125dbb318195b95b54ac329c02bb1867b46d573d40f951c77656b3822
STOCK_SCRC_BYTES=3663;  STOCK_SCRC_SHA=66c7d4922d4401e5a7ba570ea0a12e2becdca753030413bb2027b4ee0de07e02

mkdir -p "$X"; B="$X/bodies"; mkdir -p "$B"; : > "$FP_ERR"
cat > "$B/first" <<'EOF'
echo ICEBOX-WIZARD-FREE > "$HOME/first.out"
exit
EOF
cat > "$B/path" <<'EOF'
printf '%s\n' "$PATH" > "$HOME/path.out"
command -v nix > "$HOME/nix.out" 2>&1
exit
EOF
cat > "$B/omz" <<'EOF'
whence -w l > "$HOME/alias.out" 2>&1
print -r -- "ZSH=${ZSH-UNSET} THEME=${ZSH_THEME-UNSET} GUARD=${TAMANDUA_OMZ_LOADED-UNSET}" > "$HOME/omz.out"
zsh -ic 'whence -w l > "$HOME/inner.out" 2>&1; print -r -- "INNER=${ZSH-UNSET}" >> "$HOME/inner.out"' 2> "$HOME/inner.err"
exit
EOF
cat > "$B/second" <<'EOF'
exit
EOF
cat > "$B/ownomz" <<'EOF'
whence -w l > "$HOME/alias.out" 2>&1 || echo "NONE" > "$HOME/alias.out"
print -r -- "ZSH=${ZSH-UNSET} GUARD=${TAMANDUA_OMZ_LOADED-UNSET}" > "$HOME/omz.out"
exit
EOF
cat > "$B/hatch" <<'EOF'
unfunction zsh-newuser-install
whence -w zsh-newuser-install > "$HOME/hatch1.out" 2>&1
autoload -Uz zsh-newuser-install
whence -w zsh-newuser-install > "$HOME/hatch2.out" 2>&1
exit
EOF
cat > "$B/roh" <<'EOF'
echo ICEBOX-RO-OK > /tmp/mx/ro.out
exit
EOF
cat > "$B/root1" <<'EOF'
print -r -- "ZSH=${ZSH-UNSET} GUARD=${TAMANDUA_OMZ_LOADED-UNSET}" > /tmp/mx/root-own.out
exit
EOF
cat > "$B/root2" <<'EOF'
print -r -- "ZSH=${ZSH-UNSET} GUARD=${TAMANDUA_OMZ_LOADED-UNSET}" > /tmp/mx/root-alt.out
exit
EOF
cat > "$X/strip.py" <<'PY'
import re,sys
s=open(sys.argv[1],'rb').read().decode('utf-8','replace')
s=re.sub(r'\x1b\][^\x07\x1b]*(\x07|\x1b\\)','',s)
s=re.sub(r'\x1b\[[0-9;?]*[ -/]*[@-~]','',s)
s=re.sub(r'\x1b[()][A-Z0-9]|\x1b[=>]','',s)
open(sys.argv[2],'w').write(s)
PY

mkhome(){ rm -rf "$1"; mkdir -p "$1"; chown "$2:$2" "$1"; }
# pty runner: as uid, env -i except HOME/TERM/SHELL/PATH (+ extras). Records a
# failure on nonzero/timeout rc, then returns 0 so the matrix keeps gathering.
run_pty(){ local uid=$1 home=$2 body=$3 out=$4; shift 4
  timeout 60 script -qec "setpriv --reuid=$uid --regid=$uid --clear-groups env -i HOME=$home TERM=xterm SHELL=/bin/zsh PATH=/usr/bin:/bin $* /usr/bin/zsh -i" /dev/null <"$body" >"$out" 2>&1
  local rc=$?
  [ "$rc" -eq 0 ] || bad "pty run failed rc=$rc ($(basename "$out"))"
  return 0; }
run_env(){ local uid=$1 home=$2; shift 2
  setpriv --reuid=$uid --regid=$uid --clear-groups env -i HOME=$home TERM=unknown PATH=/usr/bin:/bin "$@"; }
# Fingerprint: relative-path metadata (size/mtime/mode/owner/group/type/link)
# PLUS sha256 of every regular file's CONTENT. Any enumeration/read error is
# appended to $FP_ERR (checked in S18).
tree_sig(){ { find "$1" -printf '%P %s %T@ %m %u %g %y %l\n' | sort; \
              find "$1" -type f -print0 | sort -z | xargs -0 -r sha256sum | sort; } 2>>"$FP_ERR" \
            | sha256sum | cut -d' ' -f1; }
frag_size(){ stat -c%s "$1"; }
sha(){ sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }

sec "S1 as-built static state (icebox-env image)"
if [ -d "$M" ]; then ok "asset dir present: $M"; else bad "asset dir missing: $M"; fi
eq "$(stat -c%s /etc/zsh/zshenv)" "$((STOCK_ZHENV_BYTES + $(frag_size "$M/zshenv.append")))" \
   "zshenv = stock($STOCK_ZHENV_BYTES) + fragment (single append)"
eq "$(stat -c%s /etc/zsh/zshrc)" "$((STOCK_ZHRC_BYTES + $(frag_size "$M/zshrc.append")))" \
   "zshrc = stock($STOCK_ZHRC_BYTES) + fragment (single append)"
eq "$(head -c $STOCK_ZHENV_BYTES /etc/zsh/zshenv | sha256sum | cut -d' ' -f1)" "$STOCK_ZHENV_SHA" "zshenv stock prefix byte-identical"
eq "$(head -c $STOCK_ZHRC_BYTES /etc/zsh/zshrc | sha256sum | cut -d' ' -f1)" "$STOCK_ZHRC_SHA" "zshrc stock prefix byte-identical"
tail -c "$(frag_size "$M/zshenv.append")" /etc/zsh/zshenv | cmp -s - "$M/zshenv.append" && ok "zshenv fragment tail identical" || bad "zshenv fragment tail differs"
tail -c "$(frag_size "$M/zshrc.append")" /etc/zsh/zshrc | cmp -s - "$M/zshrc.append" && ok "zshrc fragment tail identical" || bad "zshrc fragment tail differs"
eq "$(grep -c 'tamandua icebox' /etc/zsh/zshenv)" "$(grep -c 'tamandua icebox' "$M/zshenv.append")" "zshenv marker count == fragment"
eq "$(grep -c 'tamandua icebox' /etc/zsh/zshrc)" "$(grep -c 'tamandua icebox' "$M/zshrc.append")" "zshrc marker count == fragment"
zsh -n /etc/zsh/zshenv && ok "zshenv parses (zsh -n)" || bad "zshenv parse"
zsh -n /etc/zsh/zshrc && ok "zshrc parses (zsh -n)" || bad "zshrc parse"
grep -q 'compinit -C -d' /etc/zsh/zshrc && ok "compinit shim present in zshrc" || bad "compinit shim missing"
eq "$(stat -c%a /etc/profile.d/nix-path.sh)" "644" "profile.d/nix-path.sh mode 644"
cmp -s "$M/nix-path.sh" /etc/profile.d/nix-path.sh && ok "profile.d/nix-path.sh content" || bad "profile.d/nix-path.sh differs"
eq "$(stat -c%a /etc/sudoers.d/90-tamandua-guest)" "440" "sudoers drop-in mode 440"
cmp -s "$M/90-tamandua-guest" /etc/sudoers.d/90-tamandua-guest && ok "sudoers drop-in content" || bad "sudoers drop-in differs"
visudo -cf /etc/sudoers.d/90-tamandua-guest >/dev/null 2>&1 && ok "visudo -cf drop-in" || bad "visudo -cf drop-in"
visudo -c >/dev/null 2>&1 && ok "visudo -c whole configuration" || bad "visudo -c"
eq "$(stat -c%a /etc/nix/nix.conf)" "644" "nix.conf mode 644"
cmp -s "$M/nix.conf" /etc/nix/nix.conf && ok "nix.conf content" || bad "nix.conf differs"
eq "$(stat -c%s /etc/screenrc)" "$((STOCK_SCRC_BYTES + $(frag_size "$M/screenrc.block")))" "screenrc = stock + block (single append)"
eq "$(head -c $STOCK_SCRC_BYTES /etc/screenrc | sha256sum | cut -d' ' -f1)" "$STOCK_SCRC_SHA" "screenrc stock prefix byte-identical"
tail -c "$(frag_size "$M/screenrc.block")" /etc/screenrc | cmp -s - "$M/screenrc.block" && ok "screenrc operator block tail identical" || bad "screenrc block tail differs"
eq "$(grep -cF 'defscrollback 8196' /etc/screenrc)" "1" "operator scrollback directive exactly once"
eq "$(grep -cF 'defscrollback 1024' /etc/screenrc)" "1" "stock directive remains above the block"
diff -r -q /root/.oh-my-zsh /usr/share/oh-my-zsh >/dev/null && ok "/usr/share/oh-my-zsh byte-identical to /root/.oh-my-zsh" || bad "oh-my-zsh copies differ"
eq "$(find /usr/share/oh-my-zsh ! -user root -print -quit)" "" "shared oh-my-zsh root-owned"
eq "$(find /usr/share/oh-my-zsh \( -perm -g+w -o -perm -o+w \) -print -quit)" "" "shared oh-my-zsh no g/o write bits"
eq "$(find /usr/share/oh-my-zsh -type f ! -perm -o=r -print -quit)" "" "shared oh-my-zsh files world-readable"
run_env 1000 /tmp cat /usr/share/oh-my-zsh/oh-my-zsh.sh >/dev/null 2>&1 && ok "uid 1000 can read shared oh-my-zsh" || bad "uid 1000 cannot read shared oh-my-zsh"
case "$(printenv PATH)" in /nix/var/nix/profiles/default/bin:*) ok "image ENV PATH begins with nix profile bin";; *) bad "image ENV PATH: $(printenv PATH)";; esac

sec "S2 users"
getent passwd 1000 >/dev/null && ok "uid 1000 present in passwd" || bad "uid 1000 missing"
getent group 1000 >/dev/null || groupadd -g 1000 g1000
if ! getent passwd 501 >/dev/null; then
  groupadd -g 501 g501 2>/dev/null
  if useradd -u 501 -g 501 --no-create-home --home-dir /home/u501 --shell /bin/sh u501 2>/dev/null; then ok "uid 501 created (prep-style)"; else bad "useradd 501 failed"; fi
else ok "uid 501 present"; fi

sec "S3 snapshots (whole-/usr/share no-write observation window opens)"
USHARE0=$(tree_sig /usr/share)
ROOTOMZ0=$(tree_sig /root/.oh-my-zsh)
ROOTZRC0=$(sha /root/.zshrc)
ok "snapshots taken (content+metadata fingerprints)"

sec "S4 wizard-free first shell + empty rc creation (uid 1000 and 501, fresh homes)"
for uid in 1000 501; do
  h="$X/h${uid}a"; mkhome "$h" "$uid"
  run_pty "$uid" "$h" "$B/first" "$X/t${uid}a.txt"
  need "$h/first.out" "uid $uid: first-input receipt produced" || continue
  eq "$(cat "$h/first.out")" "ICEBOX-WIZARD-FREE" "uid $uid: first interactive input executed EXACTLY (no wizard swallow)"
  t=$(cat "$X/t${uid}a.txt"); eq "$?" "0" "uid $uid: transcript readable"
  eq "$(printf '%s' "$t" | grep -ci 'newuser\|keys in parentheses')" "0" "uid $uid: zero wizard markers in transcript"
  if [ -f "$h/.zshrc" ] && [ ! -s "$h/.zshrc" ]; then ok "uid $uid: empty .zshrc created"; else bad "uid $uid: .zshrc not empty/missing"; fi
  eq "$(stat -c '%u:%g' "$h/.zshrc" 2>/dev/null || echo none)" "$uid:$uid" "uid $uid: .zshrc owned by user"
done

sec "S5 non-interactive shells never create ~/.zshrc (both uids)"
for uid in 1000 501; do
  h="$X/h${uid}ni"; mkhome "$h" "$uid"
  run_env "$uid" "$h" /usr/bin/zsh -c "echo NONINT-OK > $h/nonint.out"; rc=$?
  eq "$rc" "0" "uid $uid: non-interactive zsh rc"
  eq "$(cat "$h/nonint.out" 2>/dev/null || true)" "NONINT-OK" "uid $uid: non-interactive zsh executed"
  [ ! -e "$h/.zshrc" ] && ok "uid $uid: non-interactive zsh did not create ~/.zshrc" || bad "uid $uid: non-interactive zsh created ~/.zshrc"
  h="$X/h${uid}nl"; mkhome "$h" "$uid"
  n=$(run_env "$uid" "$h" /usr/bin/zsh -lc "command -v nix"); rc=$?
  eq "$rc" "0" "uid $uid: login non-interactive zsh rc"
  eq "$n" "/nix/var/nix/profiles/default/bin/nix" "uid $uid: login non-interactive zsh sees nix"
  [ ! -e "$h/.zshrc" ] && ok "uid $uid: login non-interactive zsh did not create ~/.zshrc" || bad "uid $uid: login non-interactive zsh created ~/.zshrc"
done

sec "S6 ZDOTDIR respected (both uids)"
for uid in 1000 501; do
  h="$X/h${uid}zd"; zd="$h/zd"; mkhome "$h" "$uid"; mkdir -p "$zd"; chown "$uid:$uid" "$zd"
  run_pty "$uid" "$h" "$B/first" "$X/t${uid}zd.txt" "ZDOTDIR=$zd"
  need "$h/first.out" "uid $uid ZDOTDIR: receipt produced" || continue
  [ -f "$zd/.zshrc" ] && [ ! -s "$zd/.zshrc" ] && ok "uid $uid: empty .zshrc created in ZDOTDIR" || bad "uid $uid: ZDOTDIR .zshrc missing/nonempty"
  [ ! -e "$h/.zshrc" ] && ok "uid $uid: no .zshrc created in HOME when ZDOTDIR set" || bad "uid $uid: unexpected HOME/.zshrc"
done

sec "S7 existing ~/.zshrc never overwritten (both uids; valid zsh content)"
KEEP_CONTENT=$(printf '# ICEBOX-KEEP-ME\n: ICEBOX-KEEP-ME-VAR\n')
for uid in 1000 501; do
  h="$X/h${uid}ow"; mkhome "$h" "$uid"
  printf '%s' "$KEEP_CONTENT" > "$h/.zshrc"; chown "$uid:$uid" "$h/.zshrc"; m1=$(stat -c%Y "$h/.zshrc"); sleep 1.1
  run_pty "$uid" "$h" "$B/first" "$X/t${uid}ow.txt"
  need "$h/first.out" "uid $uid overwrite: receipt produced" || continue
  eq "$(cat "$h/.zshrc")" "$KEEP_CONTENT" "uid $uid: existing .zshrc content preserved"
  eq "$(stat -c%Y "$h/.zshrc")" "$m1" "uid $uid: existing .zshrc mtime unchanged"
  h="$X/h${uid}owe"; mkhome "$h" "$uid"
  touch "$h/.zshrc"; chown "$uid:$uid" "$h/.zshrc"; m1=$(stat -c%Y "$h/.zshrc"); sleep 1.1
  run_pty "$uid" "$h" "$B/first" "$X/t${uid}owe.txt"
  eq "$(stat -c%s "$h/.zshrc")" "0" "uid $uid: empty .zshrc still empty"
  eq "$(stat -c%Y "$h/.zshrc")" "$m1" "uid $uid: empty .zshrc mtime unchanged (noclobber no-touch)"
done

sec "S8 read-only home resilience (both uids; receipt pre-created user-owned)"
for uid in 1000 501; do
  h="$X/h${uid}ro"; mkhome "$h" "$uid"; chmod 555 "$h"
  rm -f "$X/ro.out"; install -o "$uid" -g "$uid" -m 644 /dev/null "$X/ro.out"
  run_pty "$uid" "$h" "$B/roh" "$X/t${uid}ro.txt"
  need "$X/ro.out" "uid $uid: ro receipt file present" || true
  eq "$(cat "$X/ro.out" 2>/dev/null || true)" "ICEBOX-RO-OK" "uid $uid: shell functional with read-only HOME"
  t=$(cat "$X/t${uid}ro.txt")
  eq "$(printf '%s' "$t" | grep -ci 'zshrc.*denied\|denied.*zshrc' || true)" "0" "uid $uid: no zshrc permission noise"
  [ ! -e "$h/.zshrc" ] && ok "uid $uid: no .zshrc in read-only home" || bad "uid $uid: .zshrc appeared in read-only home"
  chmod 755 "$h"
done

sec "S9 system oh-my-zsh load (both uids, fresh homes, zero errors)"
for uid in 1000 501; do
  h="$X/h${uid}omz"; mkhome "$h" "$uid"
  run_pty "$uid" "$h" "$B/omz" "$X/t${uid}omz.txt"
  need "$h/alias.out" "uid $uid omz: alias receipt produced" || continue
  need "$h/inner.out" "uid $uid omz: nested-shell receipt produced"
  need "$h/inner.err" "uid $uid omz: nested-shell stderr captured"
  has 'l: alias' "$(cat "$h/alias.out")" "uid $uid: OMZ alias l loaded"
  eq "$(cat "$h/omz.out" 2>/dev/null || true)" "ZSH=/usr/share/oh-my-zsh THEME=clean GUARD=1" "uid $uid: OMZ env shape"
  has 'l: alias' "$(cat "$h/inner.out")" "uid $uid: nested interactive shell loads its own OMZ"
  has 'INNER=/usr/share/oh-my-zsh' "$(cat "$h/inner.out")" "uid $uid: nested inner ZSH var"
  [ ! -s "$h/inner.err" ] && ok "uid $uid: nested shell stderr empty" || bad "uid $uid: nested shell stderr: $(head -2 "$h/inner.err" | tr '\n' '|')"
  t=$(cat "$X/t${uid}omz.txt")
  eq "$(printf '%s' "$t" | grep -Eic 'insecure|aborted|command not found|no such|permission denied|denied' || true)" "0" "uid $uid: zero OMZ error markers in transcript"
  if [ -s "$h/.zcompdump" ]; then ok "uid $uid: .zcompdump written"; else bad "uid $uid: .zcompdump missing"; fi
  eq "$(stat -c%u "$h/.zcompdump" 2>/dev/null || echo none)" "$uid" "uid $uid: .zcompdump user-owned"
  [ -d "$h/.cache/oh-my-zsh" ] && ok "uid $uid: per-user OMZ cache dir created" || bad "uid $uid: cache dir missing"
  m1=$(stat -c%Y "$h/.zcompdump"); sleep 1.1
  run_pty "$uid" "$h" "$B/second" "$X/t${uid}omz2.txt"
  eq "$(stat -c%Y "$h/.zcompdump")" "$m1" "uid $uid: existing .zcompdump not rewritten on next shell"
done

sec "S9b interactive startup stderr must be empty (both uids; no pty, no prompt noise)"
for uid in 1000 501; do
  h="$X/h${uid}ic"; mkhome "$h" "$uid"
  setpriv --reuid=$uid --regid=$uid --clear-groups env -i HOME=$h PATH=/usr/bin:/bin /usr/bin/zsh -ic 'exit 0' > "$X/ic$uid.out" 2> "$X/ic$uid.err"; rc=$?
  eq "$rc" "0" "uid $uid: zsh -ic rc"
  need "$X/ic$uid.err" "uid $uid: interactive stderr file captured" || continue
  [ ! -s "$X/ic$uid.err" ] && ok "uid $uid: interactive startup stderr empty (all diagnostics clean)" || bad "uid $uid: interactive stderr: $(head -3 "$X/ic$uid.err" | tr '\n' '|')"
done

sec "S10 user's own ~/.oh-my-zsh wins (both uids)"
for uid in 1000 501; do
  h="$X/h${uid}own"; mkhome "$h" "$uid"; mkdir -p "$h/.oh-my-zsh"; chown "$uid:$uid" "$h/.oh-my-zsh"
  run_pty "$uid" "$h" "$B/ownomz" "$X/t${uid}own.txt"
  need "$h/omz.out" "uid $uid own-omz: receipt produced" || continue
  need "$h/alias.out" "uid $uid own-omz: alias receipt produced"
  eq "$(cat "$h/omz.out")" "ZSH=UNSET GUARD=UNSET" "uid $uid: system loader skipped when ~/.oh-my-zsh exists"
  hasnt 'alias' "$(cat "$h/alias.out")" "uid $uid: no system OMZ alias in that shell"
done

sec "S11 root untouched"
run_pty 0 /root "$B/root1" "$X/troot.txt"
need "$X/root-own.out" "root own-home: receipt produced" || true
eq "$(cat "$X/root-own.out" 2>/dev/null || true)" "ZSH=/root/.oh-my-zsh GUARD=UNSET" "root uses its own OMZ; system loader not involved"
h="$X/hrootalt"; mkhome "$h" 0
run_pty 0 "$h" "$B/root2" "$X/trootalt.txt"
need "$X/root-alt.out" "root alt-home: receipt produced" || true
eq "$(cat "$X/root-alt.out" 2>/dev/null || true)" "ZSH=UNSET GUARD=UNSET" "root with alt HOME gets no system OMZ"
[ -f "$h/.zshrc" ] && [ ! -s "$h/.zshrc" ] && ok "root alt-home: empty .zshrc created (wizard suppression)" || bad "root alt-home .zshrc"
eq "$(grep -ci 'newuser' "$X/trootalt.txt" || true)" "0" "root alt-home: no wizard"

sec "S12 no insecure-dir scan (xtrace: zero compaudit execution frames)"
for uid in 1000 501; do
  h="$X/h${uid}tr"; mkhome "$h" "$uid"
  setpriv --reuid=$uid --regid=$uid --clear-groups env -i HOME=$h PATH=/usr/bin:/bin /usr/bin/zsh -ixc 'true' 2> "$X/trace$uid.out"; rc=$?
  eq "$rc" "0" "uid $uid: xtrace shell rc"
  eq "$(grep -cE '^\+compaudit:' "$X/trace$uid.out" || true)" "0" "uid $uid: compaudit never executed"
  eq "$(grep -ci 'insecure' "$X/trace$uid.out" || true)" "0" "uid $uid: no insecure-directory output"
  [ "$(grep -c 'compinit -C -d' "$X/trace$uid.out" || true)" -ge 1 ] && ok "uid $uid: shim call visible in trace (-C -d)" || bad "uid $uid: shim call not in trace"
  [ "$(grep -c 'oh-my-zsh.sh' "$X/trace$uid.out" || true)" -ge 1 ] && ok "uid $uid: OMZ sourced in trace" || bad "uid $uid: OMZ not sourced"
done

sec "S13 PATH visibility (both uids; interactive, non-interactive, sh/bash login)"
for uid in 1000 501; do
  h="$X/h${uid}p"; mkhome "$h" "$uid"
  run_pty "$uid" "$h" "$B/path" "$X/t${uid}p.txt"
  need "$h/nix.out" "uid $uid PATH: receipt produced" || continue
  eq "$(cat "$h/nix.out")" "/nix/var/nix/profiles/default/bin/nix" "uid $uid interactive zsh: nix"
  case "$(cat "$h/path.out")" in /nix/var/nix/profiles/default/bin:*) ok "uid $uid interactive PATH begins with nix dir";; *) bad "uid $uid interactive PATH: $(cat "$h/path.out")";; esac
  n=$(run_env "$uid" "$h" /usr/bin/zsh -c 'command -v nix'); rc=$?
  eq "$rc" "0" "uid $uid non-interactive zsh probe rc"; eq "$n" "/nix/var/nix/profiles/default/bin/nix" "uid $uid non-interactive zsh: nix"
  n=$(run_env "$uid" "$h" sh -lc 'command -v nix'); rc=$?
  eq "$rc" "0" "uid $uid sh login probe rc"; eq "$n" "/nix/var/nix/profiles/default/bin/nix" "uid $uid sh login: nix"
  n=$(run_env "$uid" "$h" bash -lc 'command -v nix'); rc=$?
  eq "$rc" "0" "uid $uid bash login probe rc"; eq "$n" "/nix/var/nix/profiles/default/bin/nix" "uid $uid bash login: nix"
done
for uid in 1000 501; do
  h="$X/h${uid}lb1"; mkhome "$h" "$uid"
  run_pty "$uid" "$h" "$B/path" "$X/t${uid}lb1.txt"
  need "$h/path.out" "uid $uid local-bin1: receipt" || continue
  hasnt "$h/.local/bin" "$(cat "$h/path.out")" "uid $uid: local-bin guard inert when dir absent"
  h="$X/h${uid}lb2"; mkhome "$h" "$uid"; mkdir -p "$h/.local/bin"; chown "$uid:$uid" "$h/.local/bin"
  run_pty "$uid" "$h" "$B/path" "$X/t${uid}lb2.txt"
  case "$(cat "$h/path.out" 2>/dev/null)" in "$h/.local/bin:"*) ok "uid $uid: local-bin guard prepends when dir exists";; *) bad "uid $uid local-bin guard: $(cat "$h/path.out" 2>/dev/null)";; esac
  h="$X/h${uid}lb3"; mkhome "$h" "$uid"; mkdir -p "$h/.local/bin"; chown "$uid:$uid" "$h/.local/bin"
  run_pty "$uid" "$h" "$B/path" "$X/t${uid}lb3.txt" "PATH=$h/.local/bin:/usr/bin:/bin"
  eq "$(grep -o "$h/.local/bin" "$h/path.out" 2>/dev/null | wc -l)" "1" "uid $uid: no duplicate when already present"
done

sec "S14 sudo (both uids; nnp + absent-uid controls)"
for uid in 1000 501; do
  h="$X/h${uid}s"; mkhome "$h" "$uid"
  id=$(setpriv --reuid=$uid --regid=$uid --clear-groups env -i HOME=$h PATH=/usr/bin:/bin sudo -n id -u 2>&1); rc=$?
  eq "$rc" "0" "uid $uid: sudo -n id rc"
  eq "$id" "0" "uid $uid: sudo -n id -u => 0"
  sp=$(setpriv --reuid=$uid --regid=$uid --clear-groups env -i HOME=$h PATH=/usr/bin:/bin sudo -n sh -c 'printf %s "$PATH"' 2>&1); rc=$?
  eq "$rc" "0" "uid $uid: sudo secure_path probe rc"
  case "$sp" in /nix/var/nix/profiles/default/bin:*) ok "uid $uid: sudo secure_path has nix FIRST";; *) bad "uid $uid sudo PATH: $sp";; esac
  nv=$(setpriv --reuid=$uid --regid=$uid --clear-groups env -i HOME=$h PATH=/usr/bin:/bin sudo -n nix --version 2>&1); rc=$?
  eq "$rc" "0" "uid $uid: sudo -n nix rc"
  has 'nix (Nix)' "$nv" "uid $uid: sudo -n nix --version via secure_path"
  # v1.2 env_keep behavioral rows (icebox IMAGE-ENVKEEP; w3-f): the drop-in keeps the
  # four matchlock MITM CA variables across sudo env_reset.
  ck1=$(setpriv --reuid=$uid --regid=$uid --clear-groups env -i HOME=$h PATH=/usr/bin:/bin \
        SSL_CERT_FILE=/x/ca.pem REQUESTS_CA_BUNDLE=/x/ca.pem CURL_CA_BUNDLE=/x/ca.pem NODE_EXTRA_CA_CERTS=/x/ca.pem \
        sudo -n sh -c 'printf "%s|%s|%s|%s" "$SSL_CERT_FILE" "$REQUESTS_CA_BUNDLE" "$CURL_CA_BUNDLE" "$NODE_EXTRA_CA_CERTS"' 2>&1); rc=$?
  eq "$rc" "0" "uid $uid: sudo CA-env probe rc"
  eq "$ck1" "/x/ca.pem|/x/ca.pem|/x/ca.pem|/x/ca.pem" "uid $uid: sudo keeps the four CA vars (env_keep)"
  ck2=$(setpriv --reuid=$uid --regid=$uid --clear-groups env -i HOME=$h PATH=/usr/bin:/bin \
        ICEBOX_KEEP_SENTINEL=keepme sudo -n sh -c 'printf %s "${ICEBOX_KEEP_SENTINEL-UNSET}"' 2>&1); rc=$?
  eq "$rc" "0" "uid $uid: sudo unrelated-env probe rc"
  eq "$ck2" "UNSET" "uid $uid: an unrelated var is still reset (env_reset intact)"
  ck3=$(setpriv --reuid=$uid --regid=$uid --clear-groups env -i HOME=$h PATH=/usr/bin:/bin \
        sudo -n sh -c 'printf %s "${SSL_CERT_FILE-UNSET}"' 2>&1); rc=$?
  eq "$rc" "0" "uid $uid: sudo absent-CA probe rc"
  eq "$ck3" "UNSET" "uid $uid: no CA value manufactured when none supplied"
  eq "$(setpriv --reuid=$uid --regid=$uid --clear-groups awk '/NoNewPrivs/{print $2}' /proc/self/status)" "0" "uid $uid: NoNewPrivs=0 in plain container"
done
o=$(setpriv --no-new-privs --reuid=1000 --regid=1000 --clear-groups env -i HOME=/tmp PATH=/usr/bin:/bin sudo -n true 2>&1); rc=$?
[ "$rc" -ne 0 ] && has 'no new privileges' "$o" "no_new_privs control: sudo refused" || bad "no_new_privs control: sudo not refused (rc=$rc)"
o=$(setpriv --reuid=4399 --regid=4399 --clear-groups env -i HOME=/tmp PATH=/usr/bin:/bin sudo -n true 2>&1); rc=$?
[ "$rc" -ne 0 ] && has 'passwd database' "$o" "absent-uid 4399: sudo refuses (prep creates the entry)" || bad "absent-uid control: $o"

sec "S15 /etc/nix/nix.conf effective for non-root (config introspection only)"
for uid in 1000 501; do
  h="$X/h${uid}n"; mkhome "$h" "$uid"
  c=$(setpriv --reuid=$uid --regid=$uid --clear-groups env -i HOME=$h PATH=/usr/bin:/bin /nix/var/nix/profiles/default/bin/nix config show experimental-features 2>&1); rc=$?
  eq "$rc" "0" "uid $uid: nix config show rc"
  has 'nix-command' "$c" "uid $uid: nix-command enabled"
  has 'flakes' "$c" "uid $uid: flakes enabled"
done

sec "S16 screen (default /etc/screenrc, both uids; full checks per uid)"
screen_block(){ local uid=$1 h="$X/h${1}scr" S="mx$1"
  mkhome "$h" "$uid"
  sj(){ setpriv --reuid=$uid --regid=$uid --clear-groups env -i HOME=$h TERM=xterm SHELL=/bin/bash PATH=/usr/bin:/bin "$@"; }
  sj screen -dmS "$S"; eq "$?" "0" "uid $uid: screen -dmS rc"
  local up=no
  for i in $(seq 1 40); do sj screen -S "$S" -Q number >/dev/null 2>&1 && { up=yes; break; }; sleep 0.25; done
  eq "$up" "yes" "uid $uid: screen session reachable"
  sleep 0.8
  local SPID; SPID=$(pgrep -u "$uid" -f "SCREEN -dmS $S" | head -1)
  if [ -z "$SPID" ]; then bad "uid $uid: screen server pid not found"; return; fi
  eq "$(ps --ppid "$SPID" -o comm= 2>/dev/null | head -1)" "zsh" "uid $uid: window shell zsh despite SHELL=/bin/bash"
  sj screen -S "$S" -p 0 -X stuff "seq 1 5000; echo SCROLL-END > $h/scroll.done"$'\n'
  for i in $(seq 1 60); do [ -f "$h/scroll.done" ] && break; sleep 0.5; done
  [ -f "$h/scroll.done" ] && ok "uid $uid: window executed scroll command" || bad "uid $uid: window did not execute"
  sleep 0.5
  sj screen -S "$S" -p 0 -X hardcopy -h "$h/hc.txt"; eq "$?" "0" "uid $uid: hardcopy rc"
  sleep 0.5
  local L; L=$(wc -l < "$h/hc.txt" 2>/dev/null || echo 0)
  [ "${L:-0}" -gt 2500 ] && ok "uid $uid: scrollback $L lines (>2500; 8196 beats stock 1024)" || bad "uid $uid: scrollback only $L lines"
  local C0 C1 C2
  C0=$(ps --ppid "$SPID" -o pid= | wc -l)
  att(){ ( sleep 2; printf "$1"; sleep 2.5; printf '\034d'; sleep 0.8 ) | timeout 45 script -qec "setpriv --reuid=$uid --regid=$uid --clear-groups env -i HOME=$h TERM=xterm SHELL=/bin/bash PATH=/usr/bin:/bin screen -S $S -r" /dev/null > "$2" 2>&1; local r=$?; sj screen -S "$S" -d >/dev/null 2>&1 || true; return $r; }
  att '\034c' "$X/att1-$uid.out"; eq "$?" "0" "uid $uid: attach round 1 rc"
  C1=$(ps --ppid "$SPID" -o pid= | wc -l)
  eq "$C1" "$((C0+1))" "uid $uid: escape ^\\ c added exactly one window ($C0 -> $C1)"
  att '\001c' "$X/att2-$uid.out"; eq "$?" "0" "uid $uid: attach round 2 rc"
  C2=$(ps --ppid "$SPID" -o pid= | wc -l)
  eq "$C2" "$C1" "uid $uid: Ctrl-A c added no window (escape rebound)"
  att '' "$X/att3-$uid.out"; eq "$?" "0" "uid $uid: attach round 3 rc"
  python3 "$X/strip.py" "$X/att3-$uid.out" "$X/att3-$uid.clean"
  # v1.1 TIME-OF-DAY FIX (2026-10-13): screen's %c renders a SPACE-padded hour before
  # 10:00 ("2026-10-13  0:30"), so the strict two-digit hour never matches at hours 0-9
  # and the assert false-reds every nightly run. Accept 1-2 digits after one or more spaces.
  local D; D=$(grep -cE '[0-9]{4}-[0-9]{2}-[0-9]{2} +[0-9]{1,2}:[0-9]{2}' "$X/att3-$uid.clean" || true)
  [ "$D" -ge 1 ] && ok "uid $uid: operator hardstatus rendered (date in bar)" || bad "uid $uid: hardstatus bar not rendered"
  sj screen -S "$S" -X quit >/dev/null 2>&1 || true
}
screen_block 1000
screen_block 501

sec "S17 escape hatch: unfunction then explicit autoload"
h="$X/h1000ha"; mkhome "$h" 1000
run_pty 1000 "$h" "$B/hatch" "$X/t1000ha.txt"
need "$h/hatch1.out" "hatch: receipt produced" || true
need "$h/hatch2.out" "hatch: second receipt produced" || true
has 'none' "$(cat "$h/hatch1.out" 2>/dev/null || true)" "after unfunction: no-op gone (no auto-restore)"
has 'function' "$(cat "$h/hatch2.out" 2>/dev/null || true)" "explicit autoload restores the stock helper"

sec "S18 no-write observation window closes"
eq "$(tree_sig /usr/share)" "$USHARE0" "/usr/share untouched by all runs (content+metadata fingerprint)"
eq "$(tree_sig /root/.oh-my-zsh)" "$ROOTOMZ0" "/root/.oh-my-zsh untouched"
eq "$(sha /root/.zshrc)" "$ROOTZRC0" "/root/.zshrc untouched"
eq "$(wc -c < "$FP_ERR")" "0" "fingerprints enumerated with zero errors"

sec "S19 installer idempotence (rerun after all assertions; full hashes)"
ZH1=$(sha /etc/zsh/zshenv); ZR1=$(sha /etc/zsh/zshrc); SC1=$(sha /etc/screenrc)
bash "$M/apply.sh" > "$X/apply2.log" 2>&1; rc=$?
eq "$rc" "0" "installer rerun rc 0"
eq "$(sha /etc/zsh/zshenv)" "$ZH1" "zshenv byte-identical on rerun"
eq "$(sha /etc/zsh/zshrc)" "$ZR1" "zshrc byte-identical on rerun"
eq "$(sha /etc/screenrc)" "$SC1" "screenrc byte-identical on rerun"
tail -c "$(frag_size "$M/screenrc.block")" /etc/screenrc | cmp -s - "$M/screenrc.block" && ok "screenrc tail still exact" || bad "screenrc tail drifted"
diff -r -q /root/.oh-my-zsh /usr/share/oh-my-zsh >/dev/null && ok "shared oh-my-zsh still byte-identical after rerun" || bad "shared oh-my-zsh drifted"
visudo -c >/dev/null 2>&1 && ok "visudo still clean" || bad "visudo after rerun"
h="$X/h1000re"; mkhome "$h" 1000
run_pty 1000 "$h" "$B/first" "$X/t1000re.txt"
need "$h/first.out" "post-rerun receipt produced" || true
eq "$(cat "$h/first.out" 2>/dev/null || true)" "ICEBOX-WIZARD-FREE" "post-rerun: wizard-free first shell holds"

echo
echo "MATRIX RESULT: FAIL=$FAIL passes=$PASS"
exit "$FAIL"
