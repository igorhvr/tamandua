# MACP8: pi credential surfacing must not require models.json (darwin parity)

On the mac, `tt-harness-auth-probe pi` fails fail-closed with
`missing surfaced file(s): .pi/agent/models.json` because
`tt-provision-home`'s pi enumeration requires `models.json` — but the mac's
real `~/.pi/agent/` legitimately has no `models.json` (linux does; pi runs
fine without it — it is an optional custom-models config, and the mac pi
answers correctly in interactive use). The enumeration treats an optional
pi config file as mandatory.

Fix: in the pi surfacing enumeration (tt-provision-home and any probe-side
mirror of the required-file list), classify `models.json` as
OPTIONAL-surface-if-present: when the real file exists it is surfaced
exactly as today; when absent, provisioning proceeds and the probe must
not name it missing. Genuinely required pi auth files (auth.json,
settings.json, and whatever else the enumeration correctly requires) stay
fail-closed exactly as today. Document the required-vs-optional split in
the enumeration's comment block.

Prove (zero real tokens beyond one probe answer leg):
- Red-arm self-test: a fixture HOME whose pi dir lacks models.json →
  pre-fix provisioning/probe fails with the exact missing-file message;
  post-fix both green; a fixture missing auth.json still fails closed
  with models.json absent AND present.
- On this host: `tt-provision-home` exit 0, then `tt-harness-auth-probe
  pi` OK (real answer leg).
- Full self-test battery green from repo root.

Hard constraints: files ONLY inside torture-test/. Never copy anything
from the operator's real HOME beyond the enumerated files; never touch
the live daemon; preserve all fail-closed semantics for required files.
