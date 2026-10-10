# tamandua icebox: nix profile on PATH for sh/bash login shells (/etc/profile.d)
case ":$PATH:" in *":/nix/var/nix/profiles/default/bin:"*) ;; *) PATH="/nix/var/nix/profiles/default/bin:$PATH"; export PATH ;; esac
