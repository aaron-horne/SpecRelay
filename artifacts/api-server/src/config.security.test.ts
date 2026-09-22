import { describe, expect, it } from "vitest";
import { validateProductionConfig } from "./config";

const names = [
  "NODE_ENV",
  "CLERK_SECRET_KEY",
  "CLERK_PUBLISHABLE_KEY",
  "VITE_CLERK_PUBLISHABLE_KEY",
  "CREDENTIAL_ENCRYPTION_KEY",
  "CREDENTIAL_ENCRYPTION_KEY_ID",
  "CREDENTIAL_ENCRYPTION_KEY_VERSION",
  "CREDENTIAL_ENCRYPTION_KEY_PREVIOUS",
  "CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_ID",
  "CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION",
  "SESSION_SECRET",
] as const;

const currentKey = "BQUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiM=";
const previousKey = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=";
const liveSecretKey = ["sk", "live", "example"].join("_");
const liveServerPublishableKey = ["pk", "live", "server-example"].join("_");
const liveBrowserPublishableKey = ["pk", "live", "browser-example"].join("_");
const testSecretKey = ["sk", "test", "example"].join("_");
const testPublishableKey = ["pk", "test", "example"].join("_");

function withProductionEnvironment(values: Record<string, string | undefined>, fn: () => void) {
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.NODE_ENV = "production";
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("production startup configuration", () => {
  it("requires canonical Clerk credentials", () => {
    withProductionEnvironment({}, () => {
      expect(() => validateProductionConfig()).toThrow(/CLERK_SECRET_KEY is required/);
    });
    withProductionEnvironment({ CLERK_SECRET_KEY: liveSecretKey }, () => {
      expect(() => validateProductionConfig())
        .toThrow(/CLERK_PUBLISHABLE_KEY is required/);
    });
    withProductionEnvironment({
      CLERK_SECRET_KEY: liveSecretKey,
      CLERK_PUBLISHABLE_KEY: liveServerPublishableKey,
    }, () => {
      expect(() => validateProductionConfig())
        .toThrow(/VITE_CLERK_PUBLISHABLE_KEY is required/);
    });
  });

  it.each([
    ["CLERK_SECRET_KEY", testSecretKey, /production Clerk sk_live_/],
    ["CLERK_PUBLISHABLE_KEY", testPublishableKey, /production Clerk pk_live_/],
    ["VITE_CLERK_PUBLISHABLE_KEY", testPublishableKey, /production Clerk pk_live_/],
  ] as const)("rejects a development %s in production", (name, value, expected) => {
    withProductionEnvironment({
      CLERK_SECRET_KEY: liveSecretKey,
      CLERK_PUBLISHABLE_KEY: liveServerPublishableKey,
      VITE_CLERK_PUBLISHABLE_KEY: liveBrowserPublishableKey,
      [name]: value,
    }, () => {
      expect(() => validateProductionConfig()).toThrow(expected);
    });
  });

  it("never uses SESSION_SECRET as the production credential key", () => {
    withProductionEnvironment({
      CLERK_SECRET_KEY: liveSecretKey,
      CLERK_PUBLISHABLE_KEY: liveServerPublishableKey,
      VITE_CLERK_PUBLISHABLE_KEY: liveBrowserPublishableKey,
      SESSION_SECRET: "development-only-session-secret",
    }, () => {
      expect(() => validateProductionConfig())
        .toThrow(/CREDENTIAL_ENCRYPTION_KEY is required in production/);
    });
  });

  it("accepts complete current and previous encryption configuration", () => {
    withProductionEnvironment({
      CLERK_SECRET_KEY: liveSecretKey,
      CLERK_PUBLISHABLE_KEY: liveServerPublishableKey,
      VITE_CLERK_PUBLISHABLE_KEY: liveBrowserPublishableKey,
      CREDENTIAL_ENCRYPTION_KEY: currentKey,
      CREDENTIAL_ENCRYPTION_KEY_ID: "credential-key-current",
      CREDENTIAL_ENCRYPTION_KEY_VERSION: "2",
      CREDENTIAL_ENCRYPTION_KEY_PREVIOUS: previousKey,
      CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_ID: "credential-key-previous",
      CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION: "1",
    }, () => {
      expect(() => validateProductionConfig()).not.toThrow();
    });
  });
});