# tt-poly java/ Subtree — CSV Ledger Parser & Money Arithmetic Library

A small Java library for parsing CSV ledgers, performing money arithmetic,
and providing a CLI interface.

Part of the tt-poly five-language storm monorepo (python, ts, go, java, rust).

Built for the tamandua torture-test suite.

## Setup

This project uses the [Maven Wrapper](https://maven.apache.org/wrapper/)
(`./mvnw`) — no system `mvn` installation is required.

### JAVA_HOME Setup (Required)

Java is intentionally **not** on the default `PATH`. You must set
`JAVA_HOME` to a JDK 21+ installation before running any Maven commands.

```bash
export JAVA_HOME=/path/to/jdk-21

# Verify the JDK is discoverable:
$JAVA_HOME/bin/java -version 2>&1

# Now you can build and test:
./mvnw -q -B test
```

If you attempt to run `./mvnw` without setting `JAVA_HOME`, the wrapper
will fail with a "JAVA_HOME is not defined correctly" error.

### Test Command

From the java/ directory:

```bash
./mvnw -q -B test
```

`-q` and `-B` (batch) flags suppress extraneous output for cleaner
test runs and make the output easier to parse.

### Build

```bash
./mvnw -q compile
```

## Module Overview

- **com.tamandua.ledger** — Core package: data model, CSV parsing,
  money utilities, business logic, and CLI entry point.

## Junk Probes

This subtree contains intentional untracked artifacts that serve as
junk probes for the torture test suite:

- `target/` — build output directory, regenerated on every test run.
  **Do NOT add to .gitignore.**
- `operator-notes.local` — inert operator notes file, never modified.

See `JUNK-IS-INTENTIONAL.md` and `README-JUNK.md` for details.
