import { GatewayError } from "../core/errors";
import type { GatewayEnv } from "../env";

/** AES-256-GCM 加密后的上游密钥。 */
export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

function base64ToBytes(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new GatewayError({
      code: "CONFIG_INVALID",
      message: "Encryption key or ciphertext is not valid base64",
      expose: false,
    });
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function importMasterKey(env: GatewayEnv): Promise<CryptoKey> {
  const raw = env.ENCRYPTION_KEY;
  if (!raw) {
    throw new GatewayError({
      code: "CONFIG_INVALID",
      message: "ENCRYPTION_KEY is not configured",
      expose: false,
    });
  }
  const bytes = base64ToBytes(raw);
  if (bytes.length !== KEY_BYTES) {
    throw new GatewayError({
      code: "CONFIG_INVALID",
      message: "ENCRYPTION_KEY must be a base64 encoded 32-byte key",
      expose: false,
    });
  }
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(env: GatewayEnv, plaintext: string): Promise<EncryptedSecret> {
  const key = await importMasterKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const tagOffset = sealed.length - TAG_BYTES;
  if (tagOffset < 0) {
    throw new GatewayError({ code: "INTERNAL_ERROR", message: "Encryption failed", expose: false });
  }
  return {
    ciphertext: bytesToBase64(sealed.subarray(0, tagOffset)),
    iv: bytesToBase64(iv),
    tag: bytesToBase64(sealed.subarray(tagOffset)),
  };
}

export async function decryptSecret(env: GatewayEnv, secret: EncryptedSecret): Promise<string> {
  const key = await importMasterKey(env);
  const ciphertext = base64ToBytes(secret.ciphertext);
  const tag = base64ToBytes(secret.tag);
  const iv = base64ToBytes(secret.iv);
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.length);
  try {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, combined);
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new GatewayError({
      code: "CONFIG_INVALID",
      message: "Failed to decrypt provider credential",
      expose: false,
    });
  }
}

const SECRET_REF_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export function isValidSecretRef(name: string): boolean {
  return SECRET_REF_PATTERN.test(name);
}

/** 从 Worker Secret 绑定中读取上游密钥。 */
export function readSecretRef(env: GatewayEnv, name: string): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}
