import { validateCredentialEncryptionConfig } from "./services/credential-crypto";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required in production`);
  }
  return value;
}

function requiredLiveClerkKey(name: string, prefix: string): void {
  const value = requiredEnvironment(name);
  if (!value.startsWith(prefix)) {
    throw new Error(`${name} must use a production Clerk ${prefix} key`);
  }
}

/**
 * Validate every setting needed before accepting production traffic.  Keep
 * this separate from request handling so a bad deployment fails at startup.
 */
export function validateProductionConfig(): void {
  if (process.env.NODE_ENV !== "production") return;

  requiredLiveClerkKey("CLERK_SECRET_KEY", "sk_live_");
  requiredLiveClerkKey("CLERK_PUBLISHABLE_KEY", "pk_live_");
  requiredLiveClerkKey("VITE_CLERK_PUBLISHABLE_KEY", "pk_live_");
  validateCredentialEncryptionConfig();
}