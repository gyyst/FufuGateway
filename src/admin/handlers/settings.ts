import type { Context } from "hono";
import type { AppEnv } from "../../app";
import { GatewayError } from "../../core/errors";
import { isRecord } from "../../core/json";
import { RUNTIME_SETTING_KEYS, setSetting } from "../../config/repository";
import { configMutationResponse, parseAdminBody } from "../shared";
import { z } from "zod";

const ALLOWED_KEYS = new Set(RUNTIME_SETTING_KEYS);

const settingsUpdateSchema = z.record(z.string(), z.unknown());

export async function getSettingsHandler(c: Context<AppEnv>): Promise<Response> {
  const rows = await c.env.DB.prepare("SELECT key, value FROM system_settings").all<{
    key: string;
    value: string;
  }>();
  const data: Record<string, unknown> = {};
  for (const row of rows.results) {
    try {
      data[row.key] = JSON.parse(row.value) as unknown;
    } catch {
      data[row.key] = row.value;
    }
  }
  return c.json({
    data,
    note: "Settings are applied automatically when saved. Changes may take up to 60 seconds to reach all instances.",
  });
}

function validateValue(key: string, value: unknown): void {
  if (key === "gateway.name") {
    if (typeof value !== "string" || value.trim() === "") {
      throw new GatewayError({ code: "INVALID_REQUEST", message: "gateway.name must be a non-empty string" });
    }
    return;
  }
  if (key === "compat.default_policy") {
    if (
      value !== "strict" &&
      value !== "warn" &&
      value !== "drop" &&
      value !== "passthrough"
    ) {
      throw new GatewayError({
        code: "INVALID_REQUEST",
        message: "compat.default_policy must be strict, warn, drop or passthrough",
      });
    }
    return;
  }
  if (key === "cors.allowed_origins") {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new GatewayError({
        code: "INVALID_REQUEST",
        message: "cors.allowed_origins must be a string array",
      });
    }
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: `${key} must be a non-negative number` });
  }
}

export async function updateSettingsHandler(c: Context<AppEnv>): Promise<Response> {
  const body = await parseAdminBody(c, settingsUpdateSchema);
  const entries = Object.entries(body);
  if (entries.length === 0) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "No settings provided" });
  }
  if (!isRecord(body)) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "Settings must be an object" });
  }
  for (const [key, value] of entries) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new GatewayError({ code: "INVALID_REQUEST", message: `Unknown setting "${key}"` });
    }
    validateValue(key, value);
  }
  for (const [key, value] of entries) {
    await setSetting(c.env.DB, key, value);
  }
  return configMutationResponse(
    c,
    "settings.update",
    "settings",
    null,
    { keys: entries.map(([key]) => key) },
    {
      data: body,
      note: "Settings saved and applied automatically. Changes may take up to 60 seconds to reach all instances.",
    },
  );
}
