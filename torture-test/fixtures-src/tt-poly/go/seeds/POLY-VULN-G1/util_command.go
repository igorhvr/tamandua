//go:build ignore

// Package util provides utility functions for command execution and archive extraction.
// This package is dormant — it is never imported by the core pool package or tests.
// All code paths here serve as vulnerability probes (VULN-G1, VULN-G2) and
// scope-bait for security-audit workflows.
package util

import (
	"os/exec"
)

// RunCommand executes a command with the given name and arguments.
// Uses exec.Command with an explicit argument list — safe from injection.
func RunCommand(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// RunCommandShell executes a shell command string via sh -c.
// VULNERABLE: unsanitized cmdStr allows shell injection (VULN-G1).
func RunCommandShell(cmdStr string) (string, error) {
	cmd := exec.Command("sh", "-c", cmdStr) // VULN-G1: shell injection via unsanitized cmdStr
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}
