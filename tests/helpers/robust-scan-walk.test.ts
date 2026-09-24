import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { tamanduaTempDir } from "../../src/lib/temp-dir.ts";
import {
  collectScanFiles,
  isTransientFixturePath,
  readCollectedFiles,
  scanRootsForContents,
  TRANSIENT_FIXTURE_PATTERNS,
  type ScanWalkDeps,
  type ScanWalkDirent,
} from "./robust-scan-walk.ts";

/**
 * TEST-HYGIENE-0923 item 3a (bead tamandua-6sy.88) coverage: the walker that a
 * source scanner uses must (a) tolerate a file or directory that vanishes
 * mid-walk without ever treating it as an offender, (b) skip documented
 * transient fixture paths, and (c) still report every finding that is really
 * there. The retired-labelled file below is the real-world offender shape: the
 * vocabulary guard forbids one exact token under src/ and e2e-tests/, and this
 * file's own label literal is assembled at runtime so it never scans itself.
 */
const FORBIDDEN = ["not", "applicable"].join("-");

function dirent(name: string, kind: "file" | "dir"): ScanWalkDirent {
  return {
    name,
    isDirectory: () => kind === "dir",
    isFile: () => kind === "file",
    isSymbolicLink: () => false,
  };
}

function errnoError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${code}: synthetic`);
  error.code = code;
  return error;
}

/** Minimal scripted fs surface for the mid-walk race cases. */
function scriptedDeps(tree: Record<string, ScanWalkDirent[]>): Partial<ScanWalkDeps> {
  return {
    readDir: (dir) => {
      const entries = tree[dir];
      if (!entries) throw errnoError("ENOENT");
      return entries;
    },
    readFile: (path) => {
      if (!existsSync(path)) throw errnoError("ENOENT");
      return readFileSync(path, "utf8");
    },
    isDirectory: (path) => tree[path] !== undefined,
  };
}

function makeScratchRoot(): string {
  return tamanduaTempDir("robust-scan-walk-");
}

describe("robust-scan-walk: real findings survive, racing transients do not", () => {
  it("reports a file containing the retired label as an offender and still reads clean files", () => {
    const root = makeScratchRoot();
    try {
      writeFileSync(join(root, "offender.ts"), `// ${FORBIDDEN} label\nexport const x = 1;\n`);
      writeFileSync(join(root, "clean.md"), "# clean\n");
      mkdirSync(join(root, "nested"));
      writeFileSync(join(root, "nested", "also-clean.ts"), "export const y = 2;\n");

      const scan = scanRootsForContents({ roots: [root], extensions: [".ts", ".md"] });
      const offenders = scan.contents
        .filter(({ text }) => text.includes(FORBIDDEN))
        .map(({ path }) => path);

      assert.equal(scan.contents.length, 3, "every existing file must be read");
      assert.equal(scan.vanishedPaths.length, 0);
      assert.deepEqual(offenders, [join(root, "offender.ts")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never treats a file that vanished after collection as an offender, and never throws", () => {
    const root = makeScratchRoot();
    try {
      const victim = join(root, "vanishing.ts");
      const survivor = join(root, "survivor.ts");
      writeFileSync(victim, `// ${FORBIDDEN} label\n`);
      writeFileSync(survivor, "export const keep = true;\n");

      // The file is present at collection time and removed by a concurrent
      // test before the read — exactly the e2e-syntax-check scratch-dir race.
      let readAttempts = 0;
      const scan = scanRootsForContents({
        roots: [root],
        extensions: [".ts"],
        deps: {
          readFile: (path) => {
            readAttempts += 1;
            if (path === victim) {
              rmSync(victim, { force: true });
              return readFileSync(path, "utf8"); // really throws ENOENT
            }
            return readFileSync(path, "utf8");
          },
        },
      });

      assert.equal(readAttempts, 2, "both collected files must be attempted");
      assert.deepEqual(scan.vanishedPaths, [victim]);
      assert.deepEqual(
        scan.contents.map(({ path }) => path),
        [survivor],
      );
      assert.deepEqual(
        scan.contents.filter(({ text }) => text.includes(FORBIDDEN)),
        [],
        "a vanished file must not be reported as an offender",
      );
      assert.ok(!existsSync(victim), "the victim really did vanish");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("red-arms the retired one-shot walk shape: fixed walker reports zero offenders where the pre-fix shape throws ENOENT", () => {
    const root = makeScratchRoot();
    try {
      const victim = join(root, "transient.ts");
      writeFileSync(victim, `// ${FORBIDDEN} label\n`);
      writeFileSync(join(root, "stable.ts"), "export const stable = 1;\n");

      // The pre-fix shape (the retired collectFiles + readFileSync loop): the
      // file list is collected, the file is gone by read time, and the walk
      // throws instead of reporting.
      const preFixWalk = (): string[] => {
        const listed = collectScanFiles({ roots: [root], extensions: [".ts"] }).files;
        rmSync(victim, { force: true }); // stands in for the concurrent test
        const offenders: string[] = [];
        for (const file of listed) {
          const contents = readFileSync(file, "utf8"); // ENOENT on the vanished file
          if (contents.includes(FORBIDDEN)) offenders.push(file);
        }
        return offenders;
      };

      assert.throws(preFixWalk, { code: "ENOENT" }, "the retired shape must fail on the vanished file");

      // The fixed walker over the same vanished file: zero offenders, no throw.
      writeFileSync(victim, `// ${FORBIDDEN} label\n`);
      const fixed = scanRootsForContents({
        roots: [root],
        extensions: [".ts"],
        deps: {
          readFile: (path) => {
            rmSync(victim, { force: true });
            return readFileSync(path, "utf8");
          },
        },
      });

      assert.deepEqual(fixed.vanishedPaths, [victim]);
      assert.deepEqual(
        fixed.contents.filter(({ text }) => text.includes(FORBIDDEN)),
        [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips transient-pattern directories and files and never descends into them", () => {
    const root = makeScratchRoot();
    try {
      mkdirSync(join(root, "syntax-gate-test-Ab3xYz"));
      writeFileSync(join(root, "syntax-gate-test-Ab3xYz", "broken.ts"), `// ${FORBIDDEN}\n`);
      mkdirSync(join(root, ".tmp-scratch"));
      writeFileSync(join(root, ".tmp-scratch", "note.md"), `// ${FORBIDDEN}\n`);
      writeFileSync(join(root, "report.tmp"), `// ${FORBIDDEN}\n`);
      writeFileSync(join(root, "real.ts"), "export const real = 1;\n");

      const scan = scanRootsForContents({ roots: [root], extensions: [".ts", ".md"] });

      assert.deepEqual(scan.files, [join(root, "real.ts")], "only the non-transient file is collected");
      assert.deepEqual(scan.contents.map(({ path }) => path), [join(root, "real.ts")]);
      assert.deepEqual(scan.skippedTransientPaths.sort(), [
        ".tmp-scratch",
        "report.tmp",
        "syntax-gate-test-Ab3xYz",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tolerates a scanned root that is missing or is not a directory", () => {
    const root = makeScratchRoot();
    try {
      const missing = join(root, "does-not-exist");
      const missingScan = scanRootsForContents({ roots: [missing], extensions: [".ts"] });
      assert.deepEqual(missingScan.files, []);
      assert.deepEqual(missingScan.contents, []);
      assert.deepEqual(missingScan.vanishedPaths, []);

      const filePath = join(root, "a-file.ts");
      writeFileSync(filePath, "export const a = 1;\n");
      const fileScan = scanRootsForContents({ roots: [filePath], extensions: [".ts"] });
      assert.deepEqual(fileScan.files, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tolerates a directory removed mid-walk (ENOENT/ENOTDIR on directory entry)", () => {
    const root = "/fake/root";
    const gone = `${root}/gone`;
    const deps = scriptedDeps({
      [root]: [dirent("gone", "dir"), dirent("kept.ts", "file")],
      // `gone` is missing from the tree map, so descending throws ENOENT.
    });

    const scan = collectScanFiles({ roots: [root], extensions: [".ts"], deps });
    assert.deepEqual(scan.files, [`${root}/kept.ts`]);
  });

  it("tolerates ENOTDIR on read and rethrows a non-racing read error", () => {
    const enotdirScan = readCollectedFiles(["/fake/a.ts", "/fake/b.ts"], {
      deps: {
        readFile: (path) => {
          if (path === "/fake/a.ts") throw errnoError("ENOTDIR");
          return "export const b = 1;\n";
        },
      },
    });
    assert.deepEqual(enotdirScan.vanishedPaths, ["/fake/a.ts"]);
    assert.deepEqual(enotdirScan.contents.map(({ path }) => path), ["/fake/b.ts"]);

    assert.throws(
      () => readCollectedFiles(["/fake/a.ts"], { deps: { readFile: () => {
        throw errnoError("EACCES");
      } } }),
      { code: "EACCES" },
      "a real I/O error must not be swallowed as a vanished file",
    );
  });

  it("rethrows a non-racing error while walking a directory", () => {
    const deps: Partial<ScanWalkDeps> = {
      isDirectory: () => true,
      readDir: () => {
        throw errnoError("EACCES");
      },
    };
    assert.throws(
      () => collectScanFiles({ roots: ["/fake/root"], extensions: [".ts"], deps }),
      { code: "EACCES" },
    );
  });

  it("prunes node_modules and .git while walking", () => {
    const root = "/fake/root";
    const deps = scriptedDeps({
      [root]: [dirent("node_modules", "dir"), dirent(".git", "dir"), dirent("src", "dir")],
      [`${root}/src`]: [dirent("index.ts", "file"), dirent("index.test.ts", "file"), dirent("notes.txt", "file")],
    });

    const scan = collectScanFiles({ roots: [root], extensions: [".ts"], deps });
    assert.deepEqual(scan.files, [`${root}/src/index.ts`, `${root}/src/index.test.ts`]);
  });

  it("documents and matches exactly the transient fixture patterns", () => {
    assert.deepEqual(
      TRANSIENT_FIXTURE_PATTERNS.map((pattern) => pattern.id),
      ["syntax-gate-test", "dot-tmp-prefix", "dot-tmp-suffix"],
    );
    for (const pattern of TRANSIENT_FIXTURE_PATTERNS) {
      assert.ok(pattern.description.length > 0, `${pattern.id} must be documented`);
    }

    assert.equal(isTransientFixturePath("fixtures/syntax-gate-test-Ab3xYz/broken.ts"), true);
    assert.equal(isTransientFixturePath("syntax-gate-test-Ab3xYz"), true);
    assert.equal(isTransientFixturePath("scratch/.tmp-lock"), true);
    assert.equal(isTransientFixturePath("scratch/report.tmp"), true);

    assert.equal(isTransientFixturePath("src/installer/step-ops.ts"), false);
    assert.equal(isTransientFixturePath("tests/tmpfile.ts"), false);
    assert.equal(isTransientFixturePath("docs/merge-branch.md"), false);
  });

  it("keeps the helper free of node:child_process so consumers stay in the parallel lane", () => {
    const source = readFileSync(new URL("./robust-scan-walk.ts", import.meta.url), "utf8");
    // Only real import specifiers count — the helper's own prose mentions the
    // module name when explaining why it must not import it.
    const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    assert.ok(specifiers.length > 0, "the helper must have explicit imports");
    assert.deepEqual(
      specifiers.filter((spec) => spec.includes("child_process")),
      [],
      "tests/helpers/robust-scan-walk.ts must not import node:child_process (serial-classification guard)",
    );
  });
});