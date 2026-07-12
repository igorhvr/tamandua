import fs from "node:fs";
import path from "node:path";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readPiConfig, writePiConfig, readPiAuth } from "../../dist/installer/pi-config.js";

describe("pi-config", () => {
  let tempHome: string;
  let tempPiAgent: string;
  let originalHome: string | undefined;
  let originalPiSettings: string | undefined;
  let originalPiAuth: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalPiSettings = process.env.PI_SETTINGS_PATH;
    originalPiAuth = process.env.PI_AUTH_PATH;
    tempHome = tamanduaTempDir("tamandua-pi-config-");
    tempPiAgent = path.join(tempHome, ".pi", "agent");
    fs.mkdirSync(tempPiAgent, { recursive: true });
    process.env.HOME = tempHome;
    delete process.env.PI_SETTINGS_PATH;
    delete process.env.PI_AUTH_PATH;
  });

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalPiSettings) process.env.PI_SETTINGS_PATH = originalPiSettings;
    else delete process.env.PI_SETTINGS_PATH;
    if (originalPiAuth) process.env.PI_AUTH_PATH = originalPiAuth;
    else delete process.env.PI_AUTH_PATH;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  describe("readPiConfig", () => {
    it("reads pi config from ~/.pi/agent/settings.json", async () => {
      const configPath = path.join(tempPiAgent, "settings.json");
      const config = { defaultProvider: "openai", defaultModel: "gpt-4" };
      fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");

      const result = await readPiConfig();
      assert.equal(result.path, configPath);
      assert.deepEqual(result.config, config);
    });

    it("throws when config file does not exist", async () => {
      await assert.rejects(readPiConfig, /Failed to read pi config/);
    });

    it("throws when config file is invalid JSON", async () => {
      const configPath = path.join(tempPiAgent, "settings.json");
      fs.writeFileSync(configPath, "not json", "utf-8");
      await assert.rejects(readPiConfig, /Failed to read pi config/);
    });

    it("uses PI_SETTINGS_PATH env var when set", async () => {
      const customPath = path.join(tempHome, "custom-settings.json");
      const config = { defaultProvider: "anthropic" };
      fs.writeFileSync(customPath, JSON.stringify(config), "utf-8");
      process.env.PI_SETTINGS_PATH = customPath;

      const result = await readPiConfig();
      assert.equal(result.path, customPath);
      assert.deepEqual(result.config, config);
    });
  });

  describe("writePiConfig", () => {
    it("writes pi config to the given path", async () => {
      const destPath = path.join(tempHome, "out-config.json");
      const config = { defaultProvider: "github" };

      await writePiConfig(destPath, config);

      const raw = fs.readFileSync(destPath, "utf-8");
      const parsed = JSON.parse(raw);
      assert.deepEqual(parsed, config);
    });
  });

  describe("readPiAuth", () => {
    it("reads pi auth from ~/.pi/agent/auth.json", async () => {
      const authPath = path.join(tempPiAgent, "auth.json");
      const auth = { openai: { type: "api_key" as const, key: "sk-test" } };
      fs.writeFileSync(authPath, JSON.stringify(auth), "utf-8");

      const result = await readPiAuth();
      assert.equal(result.path, authPath);
      assert.deepEqual(result.auth, auth);
    });

    it("uses PI_AUTH_PATH env var when set", async () => {
      const customPath = path.join(tempHome, "custom-auth.json");
      const auth = { anthropic: { type: "oauth" as const } };
      fs.writeFileSync(customPath, JSON.stringify(auth), "utf-8");
      process.env.PI_AUTH_PATH = customPath;

      const result = await readPiAuth();
      assert.equal(result.path, customPath);
      assert.deepEqual(result.auth, auth);
    });

    it("throws when auth file does not exist", async () => {
      await assert.rejects(readPiAuth, /Failed to read pi auth/);
    });
  });
});
