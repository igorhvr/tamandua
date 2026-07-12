import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  buildMedicPrompt,
  installMedicCron,
  uninstallMedicCron,
  isMedicCronInstalled,
} from "../../dist/medic/medic-cron.js";

describe("medic-cron", () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tempHome = tamanduaTempDir("tamandua-medic-cron-");
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  describe("buildMedicPrompt", () => {
    it("returns a non-empty prompt string", () => {
      const prompt = buildMedicPrompt();
      assert.ok(prompt.length > 0);
    });

    it("mentions tamandua medic and health watchdog", () => {
      const prompt = buildMedicPrompt();
      assert.ok(prompt.includes("Tamandua Medic"));
      assert.ok(prompt.includes("health watchdog"));
    });

    it("contains instructions for the medic check", () => {
      const prompt = buildMedicPrompt();
      assert.ok(prompt.includes("medic run"));
      assert.ok(prompt.includes("MEDIC_OK"));
      assert.ok(!prompt.includes('node "'), "the CLI launcher is a shell script — never node-prefixed");
    });
  });

  describe("isMedicCronInstalled", () => {
    it("returns false when not installed", async () => {
      const installed = await isMedicCronInstalled();
      assert.equal(installed, false);
    });
  });

  describe("installMedicCron", () => {
    it("installs successfully", async () => {
      const result = await installMedicCron();
      assert.equal(result.ok, true);

      const installed = await isMedicCronInstalled();
      assert.equal(installed, true);
    });

    it("is idempotent", async () => {
      await installMedicCron();
      const result = await installMedicCron();
      assert.equal(result.ok, true);
    });
  });

  describe("uninstallMedicCron", () => {
    it("uninstalls successfully", async () => {
      await installMedicCron();
      const result = await uninstallMedicCron();
      assert.equal(result.ok, true);

      const installed = await isMedicCronInstalled();
      assert.equal(installed, false);
    });

    it("does not throw when not installed", async () => {
      const result = await uninstallMedicCron();
      assert.equal(result.ok, true);
    });
  });
});
