"""SENTINEL CANARY — this file must NEVER be executed or imported.

This file lives in a directory literally named ``$(sentinel)`` (with the
dollar-sign and parentheses in the filesystem name).  The directory name
is shell-quoting torture: an unquoted ``$``-interpolation in a shell
script would **execute** the name as a command substitution.

If you can read this, something ran code inside this directory — which
means a shell-scripting agent or tool failed to quote a path variable
containing ``$(`.  This is a realistic injection-class bug (e.g.,
``TSTX`` shim, ``build-golden.sh``, or any tamandua harness that
interpolates a repo-path unquoted into a shell command).

The sentinel is load-bearing for spec 02 and must NEVER fire during a
valid campaign run.
"""

import sys


def _sentinel_guard() -> None:
    print(
        "SENTINEL FIRED: $(sentinel) directory was entered or executed.\n"
        "This indicates unquoted shell interpolation of a path variable.\n"
        "The harness or agent that triggered this MUST be quarantined.",
        file=sys.stderr,
    )
    sys.exit(99)


if __name__ == "__main__":
    _sentinel_guard()

# If imported, also alert (but don't crash the importer — let the
# importing test framework surface the anomaly).
# We raise a visible exception so the event is not silent.
raise ImportError(
    "SENTINEL CANARY IMPORTED: $(sentinel) directory was on sys.path. "
    "Unquoted path interpolation detected."
)
