import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const KEY_CONTEXT = Buffer.from("specrelay credential encryption v1", "utf8");
const KEY_SALT = Buffer.from("specrelay credential salt v1", "utf8");
export const CREDENTIAL_KEY_VERSION = 1;
export const CREDENTIAL_KEY_ID = "credential-key-v1";

export interface EncryptedCredentialSecret {
  readonly keyVersion: number;
  readonly keyId: string;
  readonly ciphertext: string;
  readonly iv: string;
  readonly authTag: string;
}

export interface CredentialEncryptionContext {
  readonly workspaceId: string;
  readonly apiId: string;
  readonly schemeName: string;
  readonly destinationHost: string;
}

type KeyEntry = { readonly id: string; readonly version: number; readonly source: string };

const KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const isProduction = () => process.env.NODE_ENV === "production";

function validateKeyMaterial(value: string, name: string): void {
  if (!KEY_PATTERN.test(value)) throw new Error(`${name} must be base64-encoded 32-byte key material`);
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64");
  } catch {
    throw new Error(`${name} must be base64-encoded 32-byte key material`);
  }
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    throw new Error(`${name} must be base64-encoded 32-byte key material`);
  }
}

function configuredVersion(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const version = Number(raw);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("Credential encryption key version is invalid");
  }
  return version;
}

function configuredId(name: string, fallback: string): string {
  const value = process.env[name] ?? fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new Error("Credential encryption key ID is invalid");
  }
  return value;
}

function keyRing(): { current: KeyEntry; previous: readonly KeyEntry[] } {
  const currentSource = process.env.CREDENTIAL_ENCRYPTION_KEY;
  const production = isProduction();
  if (production && !currentSource) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY is required in production");
  }
  if (currentSource) {
    validateKeyMaterial(currentSource, "CREDENTIAL_ENCRYPTION_KEY");
  }
  if (production && !process.env.CREDENTIAL_ENCRYPTION_KEY_ID?.trim()) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY_ID is required in production");
  }
  if (production && !process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION?.trim()) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY_VERSION is required in production");
  }
  const current: KeyEntry = currentSource
    ? {
      id: configuredId("CREDENTIAL_ENCRYPTION_KEY_ID", CREDENTIAL_KEY_ID),
      version: configuredVersion("CREDENTIAL_ENCRYPTION_KEY_VERSION", CREDENTIAL_KEY_VERSION),
      source: currentSource,
    }
    : production
      ? (() => { throw new Error("CREDENTIAL_ENCRYPTION_KEY is required in production"); })()
      : {
        // Compatibility is intentionally limited to non-production environments.
        id: "session-derived-v1",
        version: 1,
        source: process.env.SESSION_SECRET ?? "",
      };
  if (!current.source) throw new Error("Credential encryption is not configured");
  if (current.id !== "session-derived-v1" || currentSource) {
    validateKeyMaterial(current.source, "CREDENTIAL_ENCRYPTION_KEY");
  }

  const previous: KeyEntry[] = [];
  const previousSource = process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS;
  const previousId = process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_ID;
  const previousVersion = process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION;
  if (previousSource || previousId || previousVersion) {
    if (!previousSource || !previousId || !previousVersion) {
      throw new Error("Previous credential encryption key configuration is incomplete");
    }
    previous.push({
      id: configuredId("CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_ID", ""),
      version: configuredVersion("CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION", 0),
      source: previousSource,
    });
    validateKeyMaterial(previousSource, "CREDENTIAL_ENCRYPTION_KEY_PREVIOUS");
  }
  if (previous.some((entry) =>
    entry.id === current.id || entry.version === current.version || entry.source === current.source
  )) {
    throw new Error("Credential encryption key IDs, versions, and material must be unique");
  }
  return { current, previous };
}

/** Validate credential encryption settings without returning or logging key material. */
export function validateCredentialEncryptionConfig(): void {
  keyRing();
}

export function isCurrentCredentialKey(keyId: string, keyVersion: number): boolean {
  const { current } = keyRing();
  return current.id === keyId && current.version === keyVersion;
}

function deriveKey(entry: KeyEntry): Buffer {
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(entry.source, "utf8"),
    KEY_SALT,
    KEY_CONTEXT,
    32,
  ));
}

function aad(context: CredentialEncryptionContext): Buffer {
  return Buffer.from([
    context.workspaceId,
    context.apiId,
    context.schemeName,
    context.destinationHost.toLowerCase(),
  ].join("\0"), "utf8");
}

export function encryptCredentialSecret(
  secret: string,
  context: CredentialEncryptionContext,
): EncryptedCredentialSecret {
  const { current } = keyRing();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(current), iv);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion: current.version,
    keyId: current.id,
  };
}

export function decryptCredentialSecret(
  input: EncryptedCredentialSecret,
  context: CredentialEncryptionContext,
): string {
  const { current, previous } = keyRing();
  const entry = [current, ...previous].find(
    (candidate) => candidate.id === input.keyId && candidate.version === input.keyVersion,
  );
  if (!entry || !input.ciphertext || !input.iv || !input.authTag) {
    throw new Error("Unknown credential encryption version or key");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(entry),
    Buffer.from(input.iv, "base64"),
  );
  decipher.setAAD(aad(context));
  decipher.setAuthTag(Buffer.from(input.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(input.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}