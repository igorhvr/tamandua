import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import { UPDATE_CONTRACT } from "../scripts/update-contract.mjs";
import {
  REQUIRED_PHASE_FLAG_PATHS,
  assertUnwiredPhasePolicy,
  collectPhaseFlags,
  collectProductionFiles,
  findContractReferencePaths,
  unicodeCodePointCompare,
} from "./update-contract-scope-policy.ts";

function withFixture(run: (root: string) => void): void {
  const root = tamanduaTempDir("tamandua-update-scope-");
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function write(root: string, relativePath: string, content = "harmless\n"): void {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

function cloneContract(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(UPDATE_CONTRACT)) as Record<string, unknown>;
}

function setPhaseFlag(contract: Record<string, unknown>, flagPath: string, value: unknown): void {
  const segments = flagPath.split(".").slice(1);
  const property = segments.pop()!;
  let parent = contract;
  for (const segment of segments) parent = parent[segment] as Record<string, unknown>;
  parent[property] = value;
}

describe("update contract production scope policy", () => {
  it("collects every production root and exact launcher while materially excluding contract, test, docs, fixture, generated, and vendor evidence", () => {
    withFixture((root) => {
      for (const candidate of [
        "bin/tamandua",
        "src/app.ts",
        "scripts/tool.sh",
        "workflows/example/workflow.yml",
        "build",
        "install",
        "build-and-install",
        "package.json",
      ]) write(root, candidate);

      for (const excluded of [
        "scripts/update-contract.mjs",
        "src/example.test.ts",
        "src/example.spec.ts",
        "src/docs/evidence.md",
        "workflows/fixtures/evidence.yml",
        "src/node_modules/pkg/index.js",
        "src/dist/generated.js",
        "src/vendor/library.js",
        "tests/evidence.ts",
        "docs/evidence.md",
      ]) write(root, excluded, "tamandua.upgx.contract\n");

      assert.deepEqual(
        collectProductionFiles(root).map((file) => file.relativePath),
        [
          "bin/tamandua",
          "build",
          "build-and-install",
          "install",
          "package.json",
          "scripts/tool.sh",
          "src/app.ts",
          "workflows/example/workflow.yml",
        ],
      );
    });
  });

  it("skips symlinks without following an outside target or entering a cycle", () => {
    withFixture((root) => {
      write(root, "src/inside.ts");
      const outside = tamanduaTempDir("tamandua-update-scope-outside-");
      try {
        write(outside, "outside.ts", "tamandua.upgx.contract\n");
        fs.symlinkSync(path.join(outside, "outside.ts"), path.join(root, "src", "outside-link.ts"));
        fs.symlinkSync(path.join(root, "src"), path.join(root, "src", "cycle"));
        assert.deepEqual(collectProductionFiles(root).map((file) => file.relativePath), ["src/inside.ts"]);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  it("orders by Unicode code point rather than UTF-16 code unit or host locale", () => {
    const privateUse = "\uE000";
    const supplementary = "\u{10000}";
    assert.ok(unicodeCodePointCompare(privateUse, supplementary) < 0);
    withFixture((root) => {
      write(root, `src/${supplementary}.ts`);
      write(root, `src/${privateUse}.ts`);
      assert.deepEqual(collectProductionFiles(root).map((file) => file.relativePath), [
        `src/${privateUse}.ts`,
        `src/${supplementary}.ts`,
      ]);
    });
  });

  it("fails closed with actionable errors when any finite scan bound is exceeded", () => {
    const cases: Array<{
      name: string;
      setup: (root: string) => void;
      limits: Record<string, number>;
      message: RegExp;
    }> = [
      {
        name: "visited directory entries",
        setup: (root) => write(root, "src/a.ts"),
        limits: { maxVisitedEntries: 0 },
        message: /maximum visited directory entries \(0\) exceeded at src\/a\.ts/u,
      },
      {
        name: "candidate files",
        setup: (root) => write(root, "src/a.ts"),
        limits: { maxCandidateFiles: 0 },
        message: /maximum candidate files \(0\) exceeded at src\/a\.ts/u,
      },
      {
        name: "bytes per file",
        setup: (root) => write(root, "src/a.ts", "four"),
        limits: { maxBytesPerFile: 3 },
        message: /maximum bytes per file \(3\) exceeded by src\/a\.ts \(4 bytes\)/u,
      },
      {
        name: "aggregate bytes",
        setup: (root) => {
          write(root, "src/a.ts", "abc");
          write(root, "src/b.ts", "def");
        },
        limits: { maxAggregateBytes: 5 },
        message: /maximum aggregate bytes \(5\) exceeded at src\/b\.ts \(6 bytes\)/u,
      },
    ];

    for (const testCase of cases) {
      withFixture((root) => {
        testCase.setup(root);
        assert.throws(
          () => collectProductionFiles(root, testCase.limits),
          testCase.message,
          testCase.name,
        );
      });
    }
  });

  it("detects direct and indirect contract references and reports every offending path deterministically", () => {
    const sources = [
      { relativePath: "src/\u{10000}.ts", source: 'const id = "tamandua.upgx.contract";' },
      { relativePath: "src/\uE000.ts", source: 'const p = "update-" + "contract.mjs";' },
      { relativePath: "src/static.ts", source: 'import { UPDATE_CONTRACT } from "../scripts/update-contract.mjs";' },
      { relativePath: "src/dynamic.ts", source: 'await import("../scripts/update-contract.mjs");' },
      { relativePath: "src/require.cjs", source: 'require("../scripts/update-contract.mjs");' },
      { relativePath: "bin/tamandua", source: 'node scripts/update-contract.mjs "$@"' },
      { relativePath: "package.json", source: '{"scripts":{"contract":"node scripts/update-contract.mjs"}}' },
      { relativePath: "workflows/example/workflow.yml", source: "command: scripts/update-contract.mjs" },
      { relativePath: "src/harmless.ts", source: 'const message = "ordinary production content";' },
    ];

    assert.deepEqual(findContractReferencePaths(sources), [
      "bin/tamandua",
      "package.json",
      "src/dynamic.ts",
      "src/require.cjs",
      "src/static.ts",
      "src/\uE000.ts",
      "src/\u{10000}.ts",
      "workflows/example/workflow.yml",
    ]);
    assert.deepEqual(findContractReferencePaths([sources.at(-1)!]), []);
  });
});

describe("update contract phase policy", () => {
  it("pins every current authoritative phase flag path and enforces every value as false", () => {
    const flags = collectPhaseFlags(UPDATE_CONTRACT);
    assert.deepEqual(flags.map((flag) => flag.path), REQUIRED_PHASE_FLAG_PATHS);
    assert.ok(flags.every((flag) => flag.value === false));
    assert.doesNotThrow(() => assertUnwiredPhasePolicy(UPDATE_CONTRACT));

    for (const requiredPath of REQUIRED_PHASE_FLAG_PATHS) {
      const contract = cloneContract();
      setPhaseFlag(contract, requiredPath, true);
      assert.throws(
        () => assertUnwiredPhasePolicy(contract),
        (error: unknown) => error instanceof Error && error.message.includes(requiredPath),
        `${requiredPath} is individually enforced`,
      );
    }
  });

  it("fails closed when a required phase flag is removed or renamed", () => {
    const contract = cloneContract();
    const admission = contract.admission as Record<string, unknown>;
    delete admission.productionWired;
    assert.throws(
      () => assertUnwiredPhasePolicy(contract),
      /required phase flags missing: UPDATE_CONTRACT\.admission\.productionWired/u,
    );
  });

  it("requires a reviewed exact-surface allow-policy for true and non-boolean current values", () => {
    for (const value of [true, "false"]) {
      const contract = cloneContract();
      (contract.controlFlow as Record<string, unknown>).productionWired = value;
      assert.throws(
        () => assertUnwiredPhasePolicy(contract),
        /reviewed allow-policy naming exact allowed production surfaces and callers.*UPDATE_CONTRACT\.controlFlow\.productionWired/u,
      );
    }
  });

  it("does not let an unexpected newly added non-false phase flag bypass the gate", () => {
    const contract = cloneContract();
    contract.futurePhase = { productionWired: true };
    assert.throws(
      () => assertUnwiredPhasePolicy(contract),
      /UPDATE_CONTRACT\.futurePhase\.productionWired/u,
    );
  });
});
