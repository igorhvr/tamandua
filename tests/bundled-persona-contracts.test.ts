import assert from "node:assert/strict";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { describe, it } from "node:test";

interface PersonaFile {
  path: string;
  content: string;
}

const workflowsDir = resolve(import.meta.dirname, "..", "workflows");
const sharedAgentsDir = resolve(import.meta.dirname, "..", "agents", "shared");

function collectAgentPersonas(directory: string, ancestors = new Set<string>()): PersonaFile[] {
  const personas: PersonaFile[] = [];
  const realDirectory = realpathSync(directory);

  if (ancestors.has(realDirectory)) {
    return personas;
  }

  const descendants = new Set(ancestors).add(realDirectory);

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() || (entry.isSymbolicLink() && statSync(path).isDirectory())) {
      personas.push(...collectAgentPersonas(path, descendants));
    } else if (entry.name === "AGENTS.md") {
      personas.push({ path, content: readFileSync(path, "utf8") });
    }
  }

  return personas;
}

const personas = [
  ...collectAgentPersonas(workflowsDir),
  ...collectAgentPersonas(sharedAgentsDir),
];
const contractPersonas = personas.filter(({ content }) =>
  content.includes("## CRITICAL — STATUS Line Requirement"),
);
const storiesJsonPersonas = personas.filter(({ content }) => content.includes("STORIES_JSON"));
const rejectingVerifierPersonas = personas.filter(
  ({ content }) =>
    /^# (?:Tester|Verifier) Agent/m.test(content) && content.includes("STATUS: retry"),
);

function label(path: string): string {
  return path.startsWith(workflowsDir)
    ? `${basename(resolve(path, "../../../.."))}/${path.slice(workflowsDir.length + 1)}`
    : path.slice(resolve(sharedAgentsDir, "../..").length + 1);
}

describe("bundled workflow persona report contracts", () => {
  it("discovers bundled contract personas", () => {
    assert.ok(contractPersonas.length > 0);
    assert.ok(
      personas.some(({ path }) =>
        path.endsWith(join("quarantine-broken-tests-merge-worktree", "agents", "setup", "AGENTS.md")),
      ),
      "expected workflow agent-directory symlinks to be followed",
    );
    for (const name of ["pr", "setup", "verifier"]) {
      assert.ok(
        personas.some(({ path }) => path === join(sharedAgentsDir, name, "AGENTS.md")),
        `expected agents/shared/${name}/AGENTS.md to be scanned`,
      );
    }
  });

  it("removes the obsolete last-line success requirement repository-wide", () => {
    for (const persona of personas) {
      assert.doesNotMatch(
        persona.content,
        /last line\*\* of (?:successful |your )?output MUST be exactly\s*`STATUS: done`/i,
        label(persona.path),
      );
    }
  });

  it("requires standalone plain-text STATUS and KEY lines with success conventionally first", () => {
    for (const persona of contractPersonas) {
      assert.match(
        persona.content,
        /`STATUS: done` must appear as its own plain-text line[^]*convention[^]*first[^]*KEY:/i,
        label(persona.path),
      );
      assert.match(
        persona.content,
        /STATUS: and KEY: lines must start at column 0[^]*no bold[^]*backticks[^]*fences[^]*leading bullets/i,
        label(persona.path),
      );
    }
  });

  it("routes verifier rejection through step complete rather than step fail", () => {
    assert.ok(rejectingVerifierPersonas.length > 0);
    for (const persona of rejectingVerifierPersonas) {
      assert.match(
        persona.content,
        /reject[^]*`step complete <stepId>`[^]*`STATUS: retry`[^]*(?:reason|summary)/i,
        label(persona.path),
      );
      assert.match(
        persona.content,
        /Do not use `step fail`[^]*retry verdict/i,
        label(persona.path),
      );
    }
  });

  it("pins STORIES_JSON extraction-safe output in every emitting persona", () => {
    assert.ok(storiesJsonPersonas.length > 0);
    for (const persona of storiesJsonPersonas) {
      assert.match(
        persona.content,
        /STORIES_JSON[^]*minified single-line JSON array[^]*no trailing prose/i,
        label(persona.path),
      );
      assert.match(
        persona.content,
        /embedded newline-separated[^]*UPPERCASE_KEY:[^]*extractor truncates/i,
        label(persona.path),
      );
    }
  });
});
