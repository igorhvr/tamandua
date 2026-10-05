import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  STANDARD_MATCHLOCK_IMAGE,
  MATCHLOCK_IMAGE_ENV,
  resolveMatchlockImageReference,
} from "../../../dist/installer/matchlock/standard-image.js";

describe("matchlock standard image", () => {
  it("exports the canonical bare reference and env name", () => {
    assert.equal(STANDARD_MATCHLOCK_IMAGE, "igorhvr/tamandua");
    assert.equal(MATCHLOCK_IMAGE_ENV, "TAMANDUA_MATCHLOCK_IMAGE");
    // The bare reference is canonical — never a `:latest` suffix.
    assert.ok(!STANDARD_MATCHLOCK_IMAGE.includes(":"));
  });

  it("returns undefined without an opt-in and never consults the env", () => {
    assert.equal(resolveMatchlockImageReference({ requested: false }), undefined);
    assert.equal(
      resolveMatchlockImageReference({
        requested: false,
        env: { [MATCHLOCK_IMAGE_ENV]: "registry.example/other:1" },
      }),
      undefined,
    );
  });

  it("bare opt-in yields the built-in standard image", () => {
    assert.deepEqual(resolveMatchlockImageReference({ requested: true }), {
      image: STANDARD_MATCHLOCK_IMAGE,
      source: "standard",
    });
  });

  it("explicit image wins and trims surrounding whitespace", () => {
    assert.deepEqual(
      resolveMatchlockImageReference({
        requested: true,
        explicitImage: "  registry.acme/jail:2  ",
      }),
      { image: "registry.acme/jail:2", source: "explicit" },
    );
  });

  it("explicit image wins even when no bare opt-in was requested", () => {
    assert.deepEqual(
      resolveMatchlockImageReference({ requested: false, explicitImage: "img:1" }),
      { image: "img:1", source: "explicit" },
    );
  });

  it("explicit image wins over the env override and the built-in", () => {
    assert.deepEqual(
      resolveMatchlockImageReference({
        requested: true,
        explicitImage: "img:1",
        env: { [MATCHLOCK_IMAGE_ENV]: "env/img:9" },
      }),
      { image: "img:1", source: "explicit" },
    );
  });

  it("env override wins over the built-in for a standard opt-in", () => {
    assert.deepEqual(
      resolveMatchlockImageReference({
        requested: true,
        env: { [MATCHLOCK_IMAGE_ENV]: "registry.example/override:3" },
      }),
      { image: "registry.example/override:3", source: "standard" },
    );
  });

  it("env override is trimmed", () => {
    assert.deepEqual(
      resolveMatchlockImageReference({
        requested: true,
        env: { [MATCHLOCK_IMAGE_ENV]: "  registry.example/override:3  " },
      }),
      { image: "registry.example/override:3", source: "standard" },
    );
  });

  it("empty or whitespace-only env falls back to the built-in", () => {
    assert.deepEqual(
      resolveMatchlockImageReference({ requested: true, env: { [MATCHLOCK_IMAGE_ENV]: "" } }),
      { image: STANDARD_MATCHLOCK_IMAGE, source: "standard" },
    );
    assert.deepEqual(
      resolveMatchlockImageReference({ requested: true, env: { [MATCHLOCK_IMAGE_ENV]: "   " } }),
      { image: STANDARD_MATCHLOCK_IMAGE, source: "standard" },
    );
  });

  it("whitespace-only explicitImage falls back to the standard path", () => {
    assert.deepEqual(
      resolveMatchlockImageReference({ requested: true, explicitImage: "   " }),
      { image: STANDARD_MATCHLOCK_IMAGE, source: "standard" },
    );
    assert.deepEqual(
      resolveMatchlockImageReference({
        requested: true,
        explicitImage: "  ",
        env: { [MATCHLOCK_IMAGE_ENV]: "env/img:7" },
      }),
      { image: "env/img:7", source: "standard" },
    );
  });

  it("module stays pure: no node:child_process import", () => {
    const source = readFileSync(new URL("./standard-image.ts", import.meta.url), "utf8");
    assert.ok(
      !/import[^;]*["']node:child_process["']/.test(source),
      "standard-image.ts must not import node:child_process",
    );
    assert.ok(
      !/import[^;]*["']node:fs["']/.test(source),
      "standard-image.ts must not import node:fs",
    );
  });
});
