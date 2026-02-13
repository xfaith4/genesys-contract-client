import crypto from "node:crypto";

import { HttpishError, JsonObject } from "./types.js";

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function readBoolEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function readIntEnv(name: string, defaultValue: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return defaultValue;
  return clamp(Math.trunc(parsed), min, max);
}

export function parseHostAllowlist(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter((v) => !!v),
  );
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

export function isPlainObject(v: unknown): v is JsonObject {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function ensureObject(value: unknown, context: string): JsonObject {
  if (!isPlainObject(value)) {
    throw httpError(400, `${context} must be an object.`);
  }
  return value;
}

export function toNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw httpError(400, `${fieldName} must be a non-empty string.`);
  }
  return value.trim();
}

export function parsePositiveInt(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw httpError(400, `${fieldName} must be a positive integer.`);
  }
  return value;
}

export function parseBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw httpError(400, `${fieldName} must be a boolean.`);
  return value;
}

export function assertOnlyKeys(payload: JsonObject, allowed: string[], context: string): void {
  const allowedSet = new Set(allowed);
  for (const k of Object.keys(payload)) {
    if (!allowedSet.has(k)) throw httpError(400, `${context}: unknown field '${k}'.`);
  }
}

export function httpError(statusCode: number, message: string, details?: unknown): HttpishError {
  const err = new Error(message) as HttpishError;
  err.statusCode = statusCode;
  if (details !== undefined) err.details = details;
  return err;
}

export function parseRetryAfterMs(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const raw = Array.isArray(v) ? String(v[0] ?? "") : String(v);
  if (!raw.trim()) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.trunc(seconds * 1000);

  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return null;
}

export function constantTimeEqual(lhs: string, rhs: string): boolean {
  const left = Buffer.from(lhs);
  const right = Buffer.from(rhs);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function redactedPagingValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text.length <= 8) return "***";
  return `${text.slice(0, 4)}...${text.slice(-2)}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function logInfo(event: string, data: JsonObject = {}): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event,
      ...data,
    }),
  );
}

