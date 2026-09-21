import { describe, it } from "node:test";
import assert from "node:assert";
import {
  validateResolvedImageIdentity,
  validatePinnedIdentity,
  verifyImageIdentity,
  resolveImageIdentity,
  imageEffectivePathFromResolved,
  MatchlockImageError,
} from "../../../dist/installer/matchlock/image.js";

describe("matchlock image identity", () => {
  it("accepts a fully pinned identity and returns the pin", () => {
    const pin = validateResolvedImageIdentity({
      tag: "img:1",
      digest: "sha256:aaaa",
      config_digest: "sha256:bbbb",
    });
    assert.deepEqual(pin, { digest: "sha256:aaaa", config_digest: "sha256:bbbb", tag: "img:1" });
  });

  it("rejects an identity that pins nothing", () => {
    assert.throws(
      () => validateResolvedImageIdentity({ tag: "img:1" }),
      (e: unknown) => e instanceof MatchlockImageError && e.code === "image_unusable",
    );
  });

  it("rejects an identity with only one of digest/config_digest", () => {
    assert.throws(
      () => validateResolvedImageIdentity({ tag: "img:1", digest: "sha256:aaaa" }),
      (e: unknown) => e instanceof MatchlockImageError && e.code === "image_unusable",
    );
    assert.throws(
      () => validateResolvedImageIdentity({ tag: "img:1", config_digest: "sha256:bbbb" }),
      (e: unknown) => e instanceof MatchlockImageError && e.code === "image_unusable",
    );
  });

  it("throws on a non-object resolve result", () => {
    assert.throws(
      () => validateResolvedImageIdentity("bogus"),
      (e: unknown) => e instanceof MatchlockImageError && e.code === "image_unusable",
    );
  });

  it("verify rejects digest, config_digest and tag mismatches", () => {
    const exp = { digest: "sha256:aaaa", config_digest: "sha256:bbbb", tag: "img:1" };
    assert.throws(
      () => verifyImageIdentity(exp, { digest: "sha256:WRONG", config_digest: "sha256:bbbb", tag: "img:1" }),
      (e: unknown) => e instanceof MatchlockImageError && e.code === "image_identity_mismatch",
    );
    assert.throws(
      () => verifyImageIdentity(exp, { digest: "sha256:aaaa", config_digest: "sha256:WRONG", tag: "img:1" }),
      (e: unknown) => e instanceof MatchlockImageError && e.code === "image_identity_mismatch",
    );
    assert.throws(
      () => verifyImageIdentity(exp, { digest: "sha256:aaaa", config_digest: "sha256:bbbb", tag: "img:OTHER" }),
      (e: unknown) => e instanceof MatchlockImageError && e.code === "image_identity_mismatch" && /tag mismatch/.test(e.message),
    );
    assert.doesNotThrow(() =>
      verifyImageIdentity(exp, { digest: "sha256:aaaa", config_digest: "sha256:bbbb", tag: "img:1" }),
    );
  });

  it("validatePinnedIdentity validates a persisted EXPECTED identity too (fail closed before create)", () => {
    assert.throws(
      () => validatePinnedIdentity({ tag: "img:1", digest: "sha256:aaaa" }, "expected (persisted) image identity"),
      (e: unknown) => e instanceof MatchlockImageError && e.code === "image_unusable" && /expected \(persisted\) image identity/.test(e.message),
    );
    assert.deepEqual(
      validatePinnedIdentity({ digest: "sha256:x", config_digest: "sha256:y", tag: "t" }, "expected"),
      { digest: "sha256:x", config_digest: "sha256:y", tag: "t" },
    );
  });

  it("resolveImageIdentity delegates to resolve and validates", async () => {
    const pin = await resolveImageIdentity(async () => ({ digest: "sha256:x", config_digest: "sha256:y", tag: "t" }), "t");
    assert.deepEqual(pin, { digest: "sha256:x", config_digest: "sha256:y", tag: "t" });
  });
});

describe("matchlock image effective PATH discovery (US-004 ROOT item 5)", () => {
  it("extracts the image's effective guest PATH from the resolved oci env when the runtime records it", () => {
    const raw = {
      tag: "img:1",
      digest: "sha256:aaaa",
      config_digest: "sha256:bbbb",
      oci: { env: { PATH: "/opt/tamandua-synthetic-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" } },
    };
    const pin = validateResolvedImageIdentity(raw);
    assert.deepEqual(pin, {
      digest: "sha256:aaaa",
      config_digest: "sha256:bbbb",
      tag: "img:1",
    });
    // The PATH is NOT part of the immutable pin — it is discovered separately.
    assert.equal(
      imageEffectivePathFromResolved(raw),
      "/opt/tamandua-synthetic-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
  });

  it("returns undefined when the image declares no OCI env PATH", () => {
    assert.equal(imageEffectivePathFromResolved({ tag: "img:1", digest: "sha256:a", config_digest: "sha256:b", oci: { cmd: ["/bin/sh"] } }), undefined);
    assert.equal(imageEffectivePathFromResolved({ tag: "img:1", digest: "sha256:a", config_digest: "sha256:b" }), undefined);
    assert.equal(imageEffectivePathFromResolved(null), undefined);
    assert.equal(imageEffectivePathFromResolved({ oci: { env: { OTHER: "x" } } }), undefined);
    assert.equal(imageEffectivePathFromResolved({ oci: { env: { PATH: "" } } }), undefined);
    assert.equal(imageEffectivePathFromResolved({ oci: { env: { PATH: "  " } } }), undefined);
  });

  it("never trusts an oversized/control-char PATH", () => {
    assert.equal(imageEffectivePathFromResolved({ oci: { env: { PATH: "x".repeat(9000) } } }), undefined);
    assert.equal(imageEffectivePathFromResolved({ oci: { env: { PATH: "/bin\u0000evil" } } }), undefined);
  });
});
