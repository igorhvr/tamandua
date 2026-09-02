# CRED-SURF: credential surfacing — hermes dotenv fallback (darwin) + dsh lane credentials + real probe legs

Authorized by igorhvr 2026-09-01 (bd memories: triage-decisions-2026-09-01 item 5
"DSH CREDS — Surface + real probe"; macseq-2026-09-01; dogfooding-directive-2026-09-01).
Suite work only: files ONLY inside torture-test/.

## Problem A — hermes credentials vanish in non-interactive shells (darwin, blocks the mac campaign)
`torture-test/bin/tt-provision-home` (`surface_env_api_keys`) materializes harness API keys
into the contained home (pi auth.json + hermes .env) ONLY from environment variables that are
SET in the invoking shell (PI_ENV_API_KEY_MAP). The operator's own `~/.hermes/.env` — the
canonical place hermes itself reads keys from (load_hermes_dotenv) — is NOT an enumerated
fallback source. On the mac the operator's DEEPSEEK_API_KEY lives only in the interactive
`.zshrc`, so any non-interactive invocation (ssh command, `zsh -l -c`, nohup, launchd) provisions
a contained hermes with no key and `tt-harness-auth-probe` fails closed:
`harness-auth-missing: hermes — Provider 'deepseek' is set in config.yaml but no API key was found`.
(Observed 2026-09-02T00:01Z, ~/mac-torture-logs/v2/stage1-attempt1-probes-abort.out on the mac.)

## Problem B — the dsh lane has never executed (BRUN root, tier-2)
All 4 dsh tier-2 cells ran 0 tokens: dsh aborted every round with MISSING_CREDENTIAL because the
contained daemon/worker environment (started under `env -i` from torture-test/env/tt-env.sh, HOME =
contained) carries no DEEPSEEK credential and the contained HOME has no ~/.dsh user layer. The probe's
dsh leg is presence-only (binary found) and its answer leg is alpha-skipped, so preflight was green
while the lane was dead.

## Fix (all in torture-test/)
1. Enumerated dotenv fallback: for each key in PI_ENV_API_KEY_MAP that is NOT set in the invoking
   env, read EXACTLY that `KEY=VALUE` line from the operator's real `~/.hermes/.env` (if present) and
   materialize it exactly as an env-provided key is today (pi auth.json + contained hermes .env).
   Never copy the file, never copy non-enumerated lines, never write to the operator's HOME.
   provision-audit.json records the source per key: `env` | `hermes-dotenv` | `absent`.
2. dsh credentials: determine (read-only: ~/.local/bin/dsh source, `dsh --dump-config`,
   ~/.dsh/profiles user layer) how dsh resolves its DEEPSEEK credential. Surface the MINIMAL
   enumerated item so the contained daemon AND its dsh workers can run: if dsh reads
   DEEPSEEK_API_KEY from the environment, export it (from the same enumerated sources: env, then
   hermes dotenv) in the contained TT env at daemon start (tt-env.sh print / daemon-control real);
   if dsh needs a profile file, surface only the enumerated minimal file. NEVER copy ~/.dsh
   wholesale; NEVER write under the operator's ~/.dsh; sessions/ stays out.
3. tt-harness-auth-probe: make the dsh answer leg REAL behind `--spend` (one tiny completion), and
   have the real-campaign preflight (run-torture-test --include-real gate) call the probe with
   `--spend` so a dead dsh lane can never again pass preflight. Presence-only remains the default
   without `--spend`. Report the credential SOURCE (env | hermes-dotenv) in the probe's OK line so
   login-shell invocations are diagnosable on darwin.
4. Hygiene: extend the key-leak grep (hygiene canary / secrecy sweep over evidence, logs, audit
   files) to the newly materialized items; key VALUES must never appear in logs, evidence, audit
   JSON, task files, or commits.

## Prove
- Red-arm self-tests (fixture operator HOME, scripted — zero real tokens):
  (a) env unset + real-HOME .env has the key → surfaced, audit source=hermes-dotenv, probe present;
  (b) env unset + .env absent → fail-closed naming the missing key (no silent skip);
  (c) env set AND .env present with a different value → env wins, audit source=env;
  (d) non-enumerated lines in .env are never copied (byte-exact contained .env check);
  (e) dsh probe `--spend` against a scripted fake dsh: MISSING_CREDENTIAL shape → fail-closed
      'harness-auth-missing: dsh'; answering fake → OK; without --spend → presence-only as today.
- On this host: `tt-provision-home` exit 0; `tt-harness-auth-probe --spend` OK for pi, hermes AND
  dsh (real answer legs, tiny completions); key-leak grep over torture-test/var evidence = 0 hits.
- Full self-test battery green from repo root.

## Story shape (mandatory — gevr-s50-2026-09-01 rule)
ONE verification gate per story: the battery, the bin gates, and the on-host probe legs are each
their own story; no story bundles more than one gate; every proof story must complete inside one
worker round. Do not re-run a gate that a completed story already proved.

## Hard constraints
Files ONLY inside torture-test/. Never copy anything from the operator's real HOME beyond the
enumerated files/lines named above. Never touch the live daemon (33xx) or ~/.tamandua. Preserve
all fail-closed semantics. No key values in any artifact.
