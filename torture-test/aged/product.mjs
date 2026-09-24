// product.mjs — pinned product-dist resolution for the aged-state generator.
//
// Zero-token seeding drives REAL product functions (runWorkflow, step-ops,
// status, events, worktree-manager, control-server handlers).  Those are
// imported from the pinned stable product dist — by default /opt/tamandua/dist
// (the stable_product_dist_pin referenced by the Storm O12 contract) — or from
// $TAMANDUA_PRODUCT_DIST when a caller explicitly overrides it.  Missing
// modules fail closed: no silent fallback to an unverified dist.

import fs from "node:fs";
import path from "node:path";
import { gitTry } from "./seedcommon.mjs";

export const DEFAULT_PRODUCT_DIST = "/opt/tamandua/dist";

export const REQUIRED_PRODUCT_MODULES = [
  "installer/run.js",
  "installer/step-ops.js",
  "installer/status.js",
  "installer/events.js",
  "installer/worktree-manager.js",
  "installer/paths.js",
  "installer/workflow-spec.js",
  "server/control-server.js",
  "server/control-client.js",
];

export function resolveProductDist(env = process.env) {
  const dist = path.resolve(env.TAMANDUA_PRODUCT_DIST?.trim() || DEFAULT_PRODUCT_DIST);
  const missing = REQUIRED_PRODUCT_MODULES.filter((rel) => !fs.existsSync(path.join(dist, rel)));
  if (missing.length > 0) {
    throw new Error(
      `resolveProductDist: pinned product dist ${dist} is missing required modules: ${missing.join(", ")}. ` +
      "Set TAMANDUA_PRODUCT_DIST to a complete stable dist. No fallback.",
    );
  }
  // Best-effort git revision of the checkout that produced the dist (read-only).
  const distRepo = path.dirname(dist);
  const gitRev = gitTry(distRepo, ["rev-parse", "HEAD"]);
  const gitSubject = gitRev ? gitTry(distRepo, ["log", "-1", "--pretty=%s"]) : null;
  return { dist, gitRev, gitSubject, missing: [] };
}

export function distUrl(dist, rel) {
  return new URL(`file://${path.join(dist, rel)}`).href;
}
