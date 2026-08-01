#!/bin/sh
# exec-bit-probe.sh — committed junk probe for tree-hashing exec-bit checks
# This file has the executable bit set (chmod +x) and is committed that way.
# Tamandua torture-test oracles verify the exec bit survives git clone,
# git checkout, and rsync -a across platforms.
echo "exec-bit-probe: OK"
