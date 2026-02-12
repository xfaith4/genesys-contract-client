import express from "express";
import axios, { AxiosError, AxiosRequestConfig } from "axios";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type PagingType =
  | "NEXT_URI"
  | "NEXT_PAGE"
  | "CURSOR"
  | "AFTER"
  | "PAGE_NUMBER"
  | "TOTALHITS"
  | "START_INDEX"
  | "UNKNOWN";

type JsonObject = Record<string, unknown>;

type HttpishError = Error & {
  statusCode?: number;
  details?: unknown;
};

type OperationParameter = {
  name: string;
  in: string;
  required: boolean;
  type?: string | null;
  schema?: any;
};

type Operation = {
  operationId: string;
  method: string;
  path: string;
  tags: string[];
  summary?: string;
  description?: string;
  security?: any[];
  parameters: OperationParameter[];
  pagingType: PagingType;
  responseItemsPath?: string | null;
};

type ClientConfig = {
  baseUrl: string; // https://api.mypurecloud.com
  tokenUrl: string; // https://login.mypurecloud.com/oauth/token
  clientId: string;
  clientSecret: string;
  scope?: string;
};

type PagingMapEntry = {
  type: PagingType;
  itemsPath?: string | null;
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function readBoolEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function readIntEnv(name: string, defaultValue: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return defaultValue;
  return clamp(Math.trunc(parsed), min, max);
}

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

function isPlainObject(v: unknown): v is JsonObject {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function httpError(statusCode: number, message: string, details?: unknown): HttpishError {
  const err = new Error(message) as HttpishError;
  err.statusCode = statusCode;
  if (details !== undefined) err.details = details;
  return err;
}

function toNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw httpError(400, `${fieldName} must be a non-empty string.`);
  }
  return value.trim();
}

function constantTimeEqual(lhs: string, rhs: string): boolean {
  const left = Buffer.from(lhs);
  const right = Buffer.from(rhs);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function parseHostAllowlist(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter((v) => !!v),
  );
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function parseAndValidateUrl(raw: string, fieldName: string, allowedHosts: Set<string>): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw httpError(400, `${fieldName} is not a valid URL.`);
  }

  if (url.protocol !== "https:") {
    const allowLoopbackHttp = ALLOW_INSECURE_HTTP && url.protocol === "http:" && isLoopbackHost(url.hostname);
    if (!allowLoopbackHttp) {
      throw httpError(403, `${fieldName} must use https (or loopback http with ALLOW_INSECURE_HTTP=true).`);
    }
  }

  if (allowedHosts.size > 0 && !allowedHosts.has(url.hostname.toLowerCase())) {
    throw httpError(403, `${fieldName} host '${url.hostname}' is not allowlisted.`);
  }

  return url;
}

function parseRetryAfterMs(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const raw = Array.isArray(v) ? String(v[0] ?? "") : String(v);
  if (!raw.trim()) return null;

  const s = Number(raw);
  if (Number.isFinite(s) && s >= 0) return Math.trunc(s * 1000);

  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return null;
}

function logInfo(event: string, data: JsonObject = {}): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event,
      ...data,
    }),
  );
}

// ---- Server config (trust boundary) ----------------------------------------
// If SERVER_API_KEY is set, every request must include header: X-Server-Key
const SERVER_API_KEY = process.env.SERVER_API_KEY || "";
const ALLOW_WRITE_OPERATIONS = readBoolEnv("ALLOW_WRITE_OPERATIONS", false);
const ALLOW_CLIENT_OVERRIDES = readBoolEnv("ALLOW_CLIENT_OVERRIDES", false);
const ALLOW_INSECURE_HTTP = readBoolEnv("ALLOW_INSECURE_HTTP", false);
const ALLOW_ARRAY_FALLBACK = readBoolEnv("ALLOW_ARRAY_FALLBACK", false);
const DEFAULT_INCLUDE_ITEMS = readBoolEnv("DEFAULT_INCLUDE_ITEMS", true);
const REQUEST_BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || "1mb";

const HARD_MAX_LIMIT = readIntEnv("HARD_MAX_LIMIT", 100_000, 1, 1_000_000);
const HARD_MAX_PAGES = readIntEnv("HARD_MAX_PAGES", 500, 1, 10_000);
const HARD_MAX_RUNTIME_MS = readIntEnv("HARD_MAX_RUNTIME_MS", 120_000, 1_000, 900_000);

const DEFAULT_PAGE_SIZE = readIntEnv("DEFAULT_PAGE_SIZE", 100, 1, 1000);
const DEFAULT_LIMIT = clamp(readIntEnv("DEFAULT_LIMIT", 5000, 1, HARD_MAX_LIMIT), 1, HARD_MAX_LIMIT);
const DEFAULT_MAX_PAGES = clamp(readIntEnv("DEFAULT_MAX_PAGES", 50, 1, HARD_MAX_PAGES), 1, HARD_MAX_PAGES);
const DEFAULT_MAX_RUNTIME_MS = clamp(
  readIntEnv("DEFAULT_MAX_RUNTIME_MS", HARD_MAX_RUNTIME_MS, 1_000, HARD_MAX_RUNTIME_MS),
  1_000,
  HARD_MAX_RUNTIME_MS,
);

const HTTP_TIMEOUT_MS = readIntEnv("HTTP_TIMEOUT_MS", 30_000, 1_000, 180_000);
const MAX_RETRIES = readIntEnv("MAX_RETRIES", 5, 1, 12);

const ALLOWED_BASE_HOSTS = parseHostAllowlist(process.env.ALLOWED_BASE_HOSTS);
const ALLOWED_TOKEN_HOSTS = parseHostAllowlist(process.env.ALLOWED_TOKEN_HOSTS);

// Resolve repo root robustly under ESM + compiled dist
const HERE = path.dirname(fileURLToPath(import.meta.url));
// dist/index.js -> src/mcp-server/dist -> repo root is ../../..
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

const operations = readJson<Record<string, Operation>>(path.join(REPO_ROOT, "generated", "operations.json"));
const pagingMap = readJson<Record<string, PagingMapEntry>>(path.join(REPO_ROOT, "generated", "pagination-map.json"));
const swagger = readJson<any>(path.join(REPO_ROOT, "specs", "swagger.json"));
const definitions = (swagger?.definitions ?? {}) as Record<string, any>;

type PolicyList = {
  operationIds: Set<string>;
  tags: Set<string>;
  hasEntries: boolean;
};

function loadPolicyList(fileName: string): PolicyList {
  const p = path.join(REPO_ROOT, "registry", fileName);
  if (!fs.existsSync(p)) {
    return { operationIds: new Set(), tags: new Set(), hasEntries: false };
  }

  const operationIds = new Set<string>();
  const tags = new Set<string>();
  const text = fs.readFileSync(p, "utf8");

  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t === "---") continue;
    if (!t.startsWith("-")) continue;

    const raw = t.slice(1).trim().replace(/^['"]/, "").replace(/['"]$/, "");
    if (!raw) continue;
    if (raw.toLowerCase().startsWith("tag:")) {
      const tag = raw.slice(4).trim().toLowerCase();
      if (tag) tags.add(tag);
      continue;
    }
    operationIds.add(raw);
  }

  return { operationIds, tags, hasEntries: operationIds.size > 0 || tags.size > 0 };
}

function operationMatchesPolicy(op: Operation, policy: PolicyList): boolean {
  if (policy.operationIds.has(op.operationId)) return true;
  const tags = op.tags ?? [];
  for (const t of tags) {
    if (policy.tags.has(String(t).toLowerCase())) return true;
  }
  return false;
}

function loadSimpleList(fileName: string): Set<string> {
  const p = path.join(REPO_ROOT, "registry", fileName);
  if (!fs.existsSync(p)) return new Set();

  const out = new Set<string>();
  const text = fs.readFileSync(p, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t === "---") continue;
    if (!t.startsWith("-")) continue;
    const raw = t.slice(1).trim().replace(/^['"]/, "").replace(/['"]$/, "").toLowerCase();
    if (raw) out.add(raw);
  }
  return out;
}

const ALLOWLIST = loadPolicyList("allowlist.yaml");
const DENYLIST = loadPolicyList("denylist.yaml");
const REDACTION_FIELDS = new Set<string>([
  "authorization",
  "access_token",
  "refresh_token",
  "id_token",
  "token",
  "secret",
  "password",
  ...loadSimpleList("pii-redaction.yaml"),
]);

function redactForLog(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((x) => redactForLog(x));
  if (!isPlainObject(value)) return "[non-plain-object]";

  const out: JsonObject = {};
  for (const [k, v] of Object.entries(value)) {
    const key = k.toLowerCase();
    const shouldRedact = REDACTION_FIELDS.has(key) || key.includes("secret") || key.includes("token") || key.includes("password");
    out[k] = shouldRedact ? "***redacted***" : redactForLog(v);
  }
  return out;
}

function validateClientConfig(cfg: ClientConfig, source: string): ClientConfig {
  const baseUrl = toNonEmptyString(cfg.baseUrl, `${source}.baseUrl`);
  const tokenUrl = toNonEmptyString(cfg.tokenUrl, `${source}.tokenUrl`);
  const clientId = toNonEmptyString(cfg.clientId, `${source}.clientId`);
  const clientSecret = toNonEmptyString(cfg.clientSecret, `${source}.clientSecret`);

  const parsedBase = parseAndValidateUrl(baseUrl, `${source}.baseUrl`, ALLOWED_BASE_HOSTS);
  const parsedToken = parseAndValidateUrl(tokenUrl, `${source}.tokenUrl`, ALLOWED_TOKEN_HOSTS);
  if (parsedBase.pathname !== "/" && parsedBase.pathname !== "") {
    throw httpError(400, `${source}.baseUrl must be host-only (no path).`);
  }

  return {
    baseUrl: `${parsedBase.protocol}//${parsedBase.host}`,
    tokenUrl: parsedToken.toString(),
    clientId,
    clientSecret,
    scope: typeof cfg.scope === "string" && cfg.scope.trim() ? cfg.scope.trim() : undefined,
  };
}

function loadServerClientConfigFromEnv(): ClientConfig | null {
  const baseUrl = process.env.GENESYS_BASE_URL;
  const tokenUrl = process.env.GENESYS_TOKEN_URL;
  const clientId = process.env.GENESYS_CLIENT_ID;
  const clientSecret = process.env.GENESYS_CLIENT_SECRET;
  const scope = process.env.GENESYS_SCOPE;

  const allUnset = !baseUrl && !tokenUrl && !clientId && !clientSecret && !scope;
  if (allUnset) return null;

  if (!baseUrl || !tokenUrl || !clientId || !clientSecret) {
    throw httpError(
      500,
      "Server-managed credentials are partially configured. Set GENESYS_BASE_URL, GENESYS_TOKEN_URL, GENESYS_CLIENT_ID, GENESYS_CLIENT_SECRET together.",
    );
  }

  return validateClientConfig(
    {
      baseUrl,
      tokenUrl,
      clientId,
      clientSecret,
      scope,
    },
    "env",
  );
}

const SERVER_CLIENT_CONFIG = loadServerClientConfigFromEnv();

function parseClientConfig(input: unknown): ClientConfig {
  if (!isPlainObject(input)) {
    throw httpError(400, "client must be an object.");
  }

  return validateClientConfig(
    {
      baseUrl: String(input.baseUrl ?? ""),
      tokenUrl: String(input.tokenUrl ?? ""),
      clientId: String(input.clientId ?? ""),
      clientSecret: String(input.clientSecret ?? ""),
      scope: typeof input.scope === "string" ? input.scope : undefined,
    },
    "client",
  );
}

function resolveClientConfig(input: unknown): ClientConfig {
  const hasInput = input !== undefined && input !== null;

  if (SERVER_CLIENT_CONFIG && !hasInput) return SERVER_CLIENT_CONFIG;
  if (SERVER_CLIENT_CONFIG && hasInput && !ALLOW_CLIENT_OVERRIDES) {
    throw httpError(403, "Per-request client credentials are disabled by server policy.");
  }
  if (!SERVER_CLIENT_CONFIG && !hasInput) {
    throw httpError(
      400,
      "Missing client config. Provide request.client or configure server-managed credentials via GENESYS_* env vars.",
    );
  }
  if (hasInput) return parseClientConfig(input);

  throw httpError(500, "Unable to resolve client configuration.");
}

function requireServerKey(req: express.Request): void {
  if (!SERVER_API_KEY) return;
  const key = String(req.header("x-server-key") || "");
  if (!constantTimeEqual(key, SERVER_API_KEY)) {
    throw httpError(401, "Unauthorized: missing/invalid X-Server-Key.");
  }
}

function isOperationAllowed(op: Operation): boolean {
  if (DENYLIST.hasEntries && operationMatchesPolicy(op, DENYLIST)) return false;

  if (ALLOWLIST.hasEntries) {
    return operationMatchesPolicy(op, ALLOWLIST);
  }

  // Default stance if allowlist is empty: allow reads, block writes unless explicitly enabled.
  if (op.method.toUpperCase() === "GET") return true;
  return ALLOW_WRITE_OPERATIONS;
}

// ---- Token cache (safe-ish) -------------------------------------------------
// Cache key includes tokenUrl, clientId, scope, and a hash of the secret.
const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

function secretHash(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

const http = axios.create({ timeout: HTTP_TIMEOUT_MS });

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function requestWithRetry<T = any>(cfg: AxiosRequestConfig): Promise<T> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    try {
      const resp = await http.request(cfg);
      return resp.data as T;
    } catch (e) {
      const err = e as AxiosError;
      const status = err.response?.status;
      const retryable = err.response
        ? status === 408 || status === 429 || status === 502 || status === 503 || status === 504
        : true;
      if (!retryable || attempt >= MAX_RETRIES) throw err;

      const retryAfterMs = parseRetryAfterMs(err.response?.headers?.["retry-after"]);
      const backoff = retryAfterMs ?? Math.min(10_000, 250 * (2 ** (attempt - 1)));
      const jitter = Math.floor(Math.random() * 150);
      await sleep(backoff + jitter);
    }
  }
}

async function getToken(cfg: ClientConfig): Promise<string> {
  const key = `${cfg.tokenUrl}|${cfg.clientId}|${cfg.scope || ""}|${secretHash(cfg.clientSecret)}`;
  const now = Date.now();
  const cacheEntry = tokenCache.get(key);
  if (cacheEntry && cacheEntry.expiresAt > now + 60_000) return cacheEntry.accessToken;

  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  if (cfg.scope) body.set("scope", cfg.scope);

  const data = await requestWithRetry<any>({
    method: "POST",
    url: cfg.tokenUrl,
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    data: body.toString(),
  });

  const accessToken = data?.access_token;
  const expiresIn = Number(data?.expires_in ?? 1800);
  if (!accessToken) {
    throw httpError(502, "Token response missing access_token.");
  }

  tokenCache.set(key, { accessToken, expiresAt: now + expiresIn * 1000 });
  return accessToken;
}

// ---- Contract checks (strict-ish) ------------------------------------------
function resolveSchema(schema: any, stack: string[] = []): any {
  if (!schema || typeof schema !== "object") return schema;
  if (schema.$ref && typeof schema.$ref === "string") {
    const ref = schema.$ref as string;
    if (!ref.startsWith("#/definitions/")) {
      throw httpError(400, `Unsupported body schema ref '${ref}'.`);
    }
    const defName = ref.slice("#/definitions/".length);
    if (stack.includes(defName)) {
      return {};
    }
    const resolved = definitions[defName];
    if (!resolved) throw httpError(400, `Schema definition '${defName}' not found.`);
    return resolveSchema(resolved, [...stack, defName]);
  }
  return schema;
}

function validateSchemaValue(value: unknown, schema: any, location: string): string[] {
  const resolved = resolveSchema(schema);
  if (!resolved || typeof resolved !== "object") return [];

  const errors: string[] = [];

  if (Array.isArray(resolved.allOf) && resolved.allOf.length > 0) {
    for (const s of resolved.allOf) {
      errors.push(...validateSchemaValue(value, s, location));
    }
  }

  const t = resolved.type as string | undefined;
  if (t === "object" || (!t && (resolved.properties || resolved.required))) {
    if (!isPlainObject(value)) {
      errors.push(`${location}: expected object`);
      return errors;
    }

    const props = (resolved.properties ?? {}) as Record<string, any>;
    const required = Array.isArray(resolved.required) ? (resolved.required as string[]) : [];
    for (const reqName of required) {
      if (!(reqName in value)) errors.push(`${location}.${reqName}: missing required field`);
    }

    const allowAdditional = resolved.additionalProperties === true;
    const additionalSchema = isPlainObject(resolved.additionalProperties) ? resolved.additionalProperties : null;
    for (const [k, v] of Object.entries(value)) {
      if (k in props) {
        errors.push(...validateSchemaValue(v, props[k], `${location}.${k}`));
      } else if (additionalSchema) {
        errors.push(...validateSchemaValue(v, additionalSchema, `${location}.${k}`));
      } else if (!allowAdditional) {
        errors.push(`${location}.${k}: unknown field`);
      }
    }
    return errors;
  }

  if (t === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${location}: expected array`);
      return errors;
    }
    const itemsSchema = resolved.items;
    if (itemsSchema) {
      value.forEach((entry, idx) => {
        errors.push(...validateSchemaValue(entry, itemsSchema, `${location}[${idx}]`));
      });
    }
    return errors;
  }

  if (t === "string" && typeof value !== "string") errors.push(`${location}: expected string`);
  if (t === "integer" && (!Number.isInteger(value) || typeof value !== "number")) errors.push(`${location}: expected integer`);
  if (t === "number" && typeof value !== "number") errors.push(`${location}: expected number`);
  if (t === "boolean" && typeof value !== "boolean") errors.push(`${location}: expected boolean`);
  if (resolved.enum && Array.isArray(resolved.enum) && !resolved.enum.includes(value)) {
    errors.push(`${location}: must be one of ${JSON.stringify(resolved.enum)}`);
  }

  return errors;
}

function assertParams(op: Operation, params: JsonObject): void {
  const declared = new Set(op.parameters.filter((p) => p.in === "query" || p.in === "path").map((p) => p.name));
  const required = op.parameters.filter((p) => (p.in === "query" || p.in === "path") && p.required).map((p) => p.name);

  for (const r of required) {
    if (!(r in params)) throw httpError(400, `Missing required parameter '${r}' for operationId '${op.operationId}'.`);
    const v = params[r];
    if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) {
      throw httpError(400, `Required parameter '${r}' for operationId '${op.operationId}' is null/empty.`);
    }
  }

  for (const k of Object.keys(params)) {
    if (!declared.has(k)) throw httpError(400, `Unknown parameter '${k}' for operationId '${op.operationId}'. Refusing to guess.`);
  }
}

function assertBody(op: Operation, body: unknown): void {
  const method = op.method.toUpperCase();
  const bodyParam = op.parameters.find((p) => p.in === "body");
  if (!bodyParam && body !== null && body !== undefined) {
    throw httpError(400, `Operation '${op.operationId}' does not declare a request body.`);
  }
  if (method === "GET" && body !== null && body !== undefined) {
    throw httpError(400, `Operation '${op.operationId}' is GET and does not accept a body.`);
  }
  if (bodyParam?.required && (body === null || body === undefined)) {
    throw httpError(400, `Missing required body for operationId '${op.operationId}'.`);
  }
  if (!bodyParam || body === null || body === undefined) return;

  if (!isPlainObject(body) && !Array.isArray(body)) {
    throw httpError(400, `Body for operationId '${op.operationId}' must be an object or array.`);
  }

  if (bodyParam.schema) {
    const errs = validateSchemaValue(body, bodyParam.schema, "$body");
    if (errs.length > 0) {
      throw httpError(400, `Body schema validation failed for '${op.operationId}'.`, errs.slice(0, 25));
    }
  }
}

function assertContract(op: Operation, params: JsonObject, body: unknown): void {
  assertParams(op, params);
  assertBody(op, body);
}

function buildUrl(cfg: ClientConfig, op: Operation, params: JsonObject): string {
  let p = op.path;
  for (const prm of op.parameters.filter((x) => x.in === "path")) {
    if (!(prm.name in params)) throw httpError(400, `Missing required path param '${prm.name}'.`);
    p = p.replace(`{${prm.name}}`, encodeURIComponent(String(params[prm.name])));
  }
  const qs = new URLSearchParams();
  for (const prm of op.parameters.filter((x) => x.in === "query")) {
    if (prm.name in params && params[prm.name] !== null && params[prm.name] !== undefined) {
      qs.set(prm.name, String(params[prm.name]));
    }
  }
  const base = cfg.baseUrl.replace(/\/$/, "");
  const q = qs.toString();
  return q ? `${base}${p}?${q}` : `${base}${p}`;
}

// ---- Pagination safety ------------------------------------------------------
function resolveNextUrl(cfg: ClientConfig, next: string): string {
  return new URL(next, cfg.baseUrl).toString();
}

function assertSameHost(cfg: ClientConfig, url: string): void {
  const base = new URL(cfg.baseUrl);
  const u = new URL(url);
  if (u.origin !== base.origin) {
    throw httpError(400, `Refusing to follow pagination link off-host: ${u.origin} (expected ${base.origin})`);
  }
}

function getItemsByPath(resp: any, itemsPath?: string | null): any[] {
  if (!resp) return [];

  const tryPaths: (string | null | undefined)[] = [itemsPath, "$.entities", "entities", "$.results", "results"];
  for (const pth of tryPaths) {
    if (!pth) continue;
    const normalized = pth.replace(/^\$\./, "").replace(/^\$/, "");
    if (!normalized) continue;

    let cur: any = resp;
    let ok = true;
    for (const seg of normalized.split(".")) {
      if (!seg) continue;
      if (cur && typeof cur === "object" && seg in cur) cur = cur[seg];
      else {
        ok = false;
        break;
      }
    }
    if (ok) {
      if (Array.isArray(cur)) return cur;
      throw httpError(502, `itemsPath '${pth}' resolved to a non-array value.`);
    }
  }

  if (!ALLOW_ARRAY_FALLBACK) return [];
  for (const [, v] of Object.entries(resp)) {
    if (Array.isArray(v)) return v as any[];
  }
  return [];
}

function redactPagingValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const asText = String(value);
  if (asText.length <= 8) return "***";
  return `${asText.slice(0, 4)}...${asText.slice(-2)}`;
}

async function callOnce(cfg: ClientConfig, op: Operation, params: JsonObject, body?: any, overrideUrl?: string): Promise<any> {
  const token = await getToken(cfg);
  const url = overrideUrl ? resolveNextUrl(cfg, overrideUrl) : buildUrl(cfg, op, params);
  assertSameHost(cfg, url);

  const method = overrideUrl ? "GET" : op.method.toUpperCase();
  const data = await requestWithRetry<any>({
    method,
    url,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(method === "POST" || method === "PUT" || method === "PATCH" ? { "Content-Type": "application/json" } : {}),
    },
    data: method === "POST" || method === "PUT" || method === "PATCH" ? body : undefined,
  });

  return data;
}

function mapErrorToHttp(e: any): { status: number; message: string; details?: any } {
  if (e?.statusCode) return { status: Number(e.statusCode), message: e.message ?? String(e), details: e.details };

  const err = e as AxiosError;
  const status = err.response?.status;
  if (status) {
    const msg = (err.response?.data as any)?.message || err.message;
    return { status, message: msg, details: err.response?.data };
  }

  if (err.code === "ECONNABORTED") return { status: 504, message: "Upstream request timed out.", details: err.code };

  return { status: 500, message: e?.message ?? String(e) };
}

function ensureObject(payload: unknown, context: string): JsonObject {
  if (!isPlainObject(payload)) throw httpError(400, `${context} must be an object.`);
  return payload;
}

function assertOnlyKeys(payload: JsonObject, allowed: string[], context: string): void {
  const allowedSet = new Set(allowed);
  for (const k of Object.keys(payload)) {
    if (!allowedSet.has(k)) throw httpError(400, `${context}: unknown field '${k}'.`);
  }
}

function parsePositiveInt(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw httpError(400, `${fieldName} must be a positive integer.`);
  }
  return value;
}

function parseBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw httpError(400, `${fieldName} must be a boolean.`);
  return value;
}

function setPagingInBody(body: unknown, pageNumber: number, pageSize: number): JsonObject {
  if (body === null || body === undefined) {
    return { paging: { pageNumber, pageSize } };
  }
  if (!isPlainObject(body)) throw httpError(400, "Body paging requires object body.");
  return { ...body, paging: { pageNumber, pageSize } };
}

function setBodyToken(body: unknown, key: "cursor" | "after", value: string): JsonObject {
  if (body === null || body === undefined) return { [key]: value };
  if (!isPlainObject(body)) throw httpError(400, `${key} paging requires object body.`);
  return { ...body, [key]: value };
}

function getOp(operationId: string): Operation {
  let op = operations[operationId];
  if (!op) {
    for (const candidate of Object.values(operations)) {
      if (candidate.operationId === operationId) {
        op = candidate;
        break;
      }
    }
  }
  if (!op) throw httpError(404, "unknown operationId");
  if (!isOperationAllowed(op)) throw httpError(403, "operationId not allowed by server policy");
  return op;
}

function getPagingEntry(operationId: string, op: Operation): PagingMapEntry {
  const direct = pagingMap[operationId];
  if (direct) return direct;

  const catalogKey = (op as any).catalogKey as string | undefined;
  if (catalogKey && pagingMap[catalogKey]) return pagingMap[catalogKey];

  for (const [k, candidate] of Object.entries(operations)) {
    if (candidate.operationId === operationId && pagingMap[k]) {
      return pagingMap[k];
    }
  }

  return { type: op.pagingType, itemsPath: op.responseItemsPath };
}

function searchOperations(query: string, method?: string, tag?: string, limit = 25): Operation[] {
  const q = query.trim().toLowerCase();
  const m = (method ?? "").trim().toUpperCase();
  const t = (tag ?? "").trim().toLowerCase();

  const out: Operation[] = [];
  for (const op of Object.values(operations)) {
    if (!isOperationAllowed(op)) continue;
    if (m && op.method.toUpperCase() !== m) continue;
    if (t && !op.tags.some((x) => String(x).toLowerCase() === t)) continue;
    const hay = `${op.operationId} ${op.method} ${op.path} ${(op.summary ?? "")} ${(op.description ?? "")} ${op.tags.join(" ")}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    out.push(op);
    if (out.length >= limit) break;
  }
  return out;
}

function policySnapshot(): JsonObject {
  return {
    allowlist: {
      operationIdCount: ALLOWLIST.operationIds.size,
      tagCount: ALLOWLIST.tags.size,
    },
    denylist: {
      operationIdCount: DENYLIST.operationIds.size,
      tagCount: DENYLIST.tags.size,
    },
    allowWrites: ALLOW_WRITE_OPERATIONS,
    serverManagedCredentials: SERVER_CLIENT_CONFIG !== null,
    allowClientOverrides: ALLOW_CLIENT_OVERRIDES,
  };
}

async function executeDescribe(payload: JsonObject): Promise<JsonObject> {
  assertOnlyKeys(payload, ["operationId"], "describe");
  const operationId = toNonEmptyString(payload.operationId, "operationId");
  const op = getOp(operationId);
  return {
    operation: op,
    paging: getPagingEntry(operationId, op),
    policy: policySnapshot(),
  };
}

async function executeCall(payload: JsonObject): Promise<JsonObject> {
  assertOnlyKeys(payload, ["client", "operationId", "params", "body"], "call");
  const operationId = toNonEmptyString(payload.operationId, "operationId");
  const params = payload.params === undefined ? {} : ensureObject(payload.params, "params");
  const body = payload.body ?? null;
  const op = getOp(operationId);
  assertContract(op, params, body);
  const client = resolveClientConfig(payload.client);
  const data = await callOnce(client, op, params, body);
  return { data };
}

async function executeCallAll(payload: JsonObject): Promise<JsonObject> {
  assertOnlyKeys(payload, ["client", "operationId", "params", "body", "pageSize", "limit", "maxPages", "maxRuntimeMs", "includeItems"], "callAll");

  const operationId = toNonEmptyString(payload.operationId, "operationId");
  const params = payload.params === undefined ? {} : ensureObject(payload.params, "params");
  const body = payload.body ?? null;
  const op = getOp(operationId);
  assertContract(op, params, body);

  const pageSize = clamp(parsePositiveInt(payload.pageSize, "pageSize") ?? DEFAULT_PAGE_SIZE, 1, 1000);
  const limit = clamp(parsePositiveInt(payload.limit, "limit") ?? DEFAULT_LIMIT, 1, HARD_MAX_LIMIT);
  const maxPages = clamp(parsePositiveInt(payload.maxPages, "maxPages") ?? DEFAULT_MAX_PAGES, 1, HARD_MAX_PAGES);
  const maxRuntimeMs = clamp(parsePositiveInt(payload.maxRuntimeMs, "maxRuntimeMs") ?? DEFAULT_MAX_RUNTIME_MS, 1000, HARD_MAX_RUNTIME_MS);
  const includeItems = parseBoolean(payload.includeItems, "includeItems") ?? DEFAULT_INCLUDE_ITEMS;

  const map = getPagingEntry(operationId, op);
  const ptype: PagingType = map.type;
  const itemsPath = map.itemsPath ?? op.responseItemsPath ?? "$.entities";
  if (ptype === "UNKNOWN") throw httpError(400, `Unknown pagination type for ${operationId}. Add to registry or regenerate.`);
  const client = resolveClientConfig(payload.client);

  const items: any[] = [];
  const audit: any[] = [];
  const seenTokens = new Set<string>();

  let page = 1;
  let next: string | null = null;
  let cursor: string | null = null;
  let after: string | null = null;
  let pageNumber = 1;
  let totalFetched = 0;
  const startedAt = Date.now();

  while (true) {
    if (Date.now() - startedAt > maxRuntimeMs) {
      audit.push({ page, stop: "maxRuntimeMs", maxRuntimeMs });
      break;
    }
    if (page > maxPages) {
      audit.push({ page, stop: "maxPages", maxPages });
      break;
    }

    const localParams: JsonObject = { ...params };
    let localBody: unknown = body;

    if (ptype === "PAGE_NUMBER" || ptype === "TOTALHITS") {
      if (op.parameters.some((p) => p.in === "query" && p.name === "pageNumber")) {
        localParams.pageNumber = pageNumber;
        localParams.pageSize = pageSize;
      } else {
        localBody = setPagingInBody(localBody, pageNumber, pageSize);
      }
    } else if (ptype === "CURSOR" && cursor) {
      if (op.parameters.some((p) => p.in === "query" && p.name === "cursor")) localParams.cursor = cursor;
      else localBody = setBodyToken(localBody, "cursor", cursor);
    } else if (ptype === "AFTER" && after) {
      if (op.parameters.some((p) => p.in === "query" && p.name === "after")) localParams.after = after;
      else localBody = setBodyToken(localBody, "after", after);
    }

    const data = await callOnce(client, op, localParams, localBody, next ?? undefined);
    const batch = getItemsByPath(data, itemsPath);
    totalFetched += batch.length;

    if (includeItems) {
      const remaining = Math.max(0, limit - items.length);
      if (remaining > 0) items.push(...batch.slice(0, remaining));
    }

    audit.push({
      page,
      fetched: batch.length,
      totalFetched,
      pagingType: ptype,
      itemsPath,
      nextUri: redactPagingValue(data?.nextUri),
      nextPage: redactPagingValue(data?.nextPage),
      cursor: redactPagingValue(data?.cursor),
      after: redactPagingValue(data?.after),
      pageNumber: data?.pageNumber ?? null,
      pageCount: data?.pageCount ?? null,
      totalHits: data?.totalHits ?? null,
    });

    if (totalFetched >= limit) {
      audit.push({ page, stop: "limit", limit });
      break;
    }
    if (batch.length === 0) {
      audit.push({ page, stop: "emptyBatch" });
      break;
    }

    next = null;

    if (ptype === "NEXT_URI") {
      next = data?.nextUri ?? null;
      if (!next) {
        audit.push({ page, stop: "missingNextUri" });
        break;
      }
      const marker = `nextUri:${next}`;
      if (seenTokens.has(marker)) {
        audit.push({ page, stop: "repeatNextUri" });
        break;
      }
      seenTokens.add(marker);
    } else if (ptype === "NEXT_PAGE") {
      next = data?.nextPage ?? null;
      if (!next) {
        audit.push({ page, stop: "missingNextPage" });
        break;
      }
      const marker = `nextPage:${next}`;
      if (seenTokens.has(marker)) {
        audit.push({ page, stop: "repeatNextPage" });
        break;
      }
      seenTokens.add(marker);
    } else if (ptype === "CURSOR") {
      cursor = data?.cursor ?? null;
      if (!cursor) {
        audit.push({ page, stop: "missingCursor" });
        break;
      }
      const marker = `cursor:${cursor}`;
      if (seenTokens.has(marker)) {
        audit.push({ page, stop: "repeatCursor" });
        break;
      }
      seenTokens.add(marker);
    } else if (ptype === "AFTER") {
      after = data?.after ?? null;
      if (!after) {
        audit.push({ page, stop: "missingAfter" });
        break;
      }
      const marker = `after:${after}`;
      if (seenTokens.has(marker)) {
        audit.push({ page, stop: "repeatAfter" });
        break;
      }
      seenTokens.add(marker);
    } else if (ptype === "PAGE_NUMBER") {
      const pn = Number(data?.pageNumber ?? 0);
      const pc = Number(data?.pageCount ?? 0);
      if (pc && pn && pn >= pc) {
        audit.push({ page, stop: "reachedPageCount", pageNumber: pn, pageCount: pc });
        break;
      }
      pageNumber++;
    } else if (ptype === "TOTALHITS") {
      const th = Number(data?.totalHits ?? 0);
      if (!th) {
        audit.push({ page, stop: "missingTotalHits" });
        break;
      }
      if (pageNumber * pageSize >= th) {
        audit.push({ page, stop: "reachedTotalHits", totalHits: th });
        break;
      }
      pageNumber++;
    }

    page++;
  }

  const response: JsonObject = {
    operationId,
    pagingType: ptype,
    itemsPath,
    limit,
    maxPages,
    pageSize,
    maxRuntimeMs,
    totalFetched,
    returnedItems: includeItems ? items.length : 0,
    includeItems,
    audit,
  };
  if (includeItems) response.items = items;
  return response;
}

// ---- HTTP endpoints (can be wrapped by an MCP adapter) ----------------------
declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));
app.use((req, res, next) => {
  req.requestId = String(req.header("x-request-id") || "") || crypto.randomUUID();
  res.setHeader("x-request-id", req.requestId);
  next();
});
app.use((req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    logInfo("http.request", {
      requestId: req.requestId ?? "",
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - started,
    });
  });
  next();
});

app.get("/healthz", (_req, res) => res.json({ ok: true, transport: "http-wrapper", service: "genesys-contract-client" }));

app.post("/describe", async (req, res) => {
  try {
    requireServerKey(req);
    const response = await executeDescribe(ensureObject(req.body ?? {}, "describe payload"));
    return res.json({ ...response, requestId: req.requestId });
  } catch (e: any) {
    const mapped = mapErrorToHttp(e);
    return res.status(mapped.status).json({ error: mapped.message, details: mapped.details, requestId: req.requestId });
  }
});

app.post("/call", async (req, res) => {
  try {
    requireServerKey(req);
    const payload = ensureObject(req.body ?? {}, "call payload");
    logInfo("call.request", {
      requestId: req.requestId ?? "",
      operationId: payload.operationId ? String(payload.operationId) : "",
      params: redactForLog(payload.params),
      body: redactForLog(payload.body),
    });
    const response = await executeCall(payload);
    return res.json({ ...response, requestId: req.requestId });
  } catch (e: any) {
    const mapped = mapErrorToHttp(e);
    return res.status(mapped.status).json({ error: mapped.message, details: mapped.details, requestId: req.requestId });
  }
});

app.post("/callAll", async (req, res) => {
  try {
    requireServerKey(req);
    const payload = ensureObject(req.body ?? {}, "callAll payload");
    logInfo("callAll.request", {
      requestId: req.requestId ?? "",
      operationId: payload.operationId ? String(payload.operationId) : "",
      params: redactForLog(payload.params),
      body: redactForLog(payload.body),
      pageSize: payload.pageSize,
      limit: payload.limit,
      maxPages: payload.maxPages,
      maxRuntimeMs: payload.maxRuntimeMs,
    });
    const response = await executeCallAll(payload);
    return res.json({ ...response, requestId: req.requestId });
  } catch (e: any) {
    const mapped = mapErrorToHttp(e);
    return res.status(mapped.status).json({ error: mapped.message, details: mapped.details, requestId: req.requestId });
  }
});

app.post("/searchOperations", (req, res) => {
  try {
    requireServerKey(req);
    const payload = ensureObject(req.body ?? {}, "searchOperations payload");
    assertOnlyKeys(payload, ["query", "method", "tag", "limit"], "searchOperations");
    const query = typeof payload.query === "string" ? payload.query : "";
    const method = typeof payload.method === "string" ? payload.method : undefined;
    const tag = typeof payload.tag === "string" ? payload.tag : undefined;
    const limit = clamp(parsePositiveInt(payload.limit, "limit") ?? 25, 1, 200);
    const ops = searchOperations(query, method, tag, limit);
    return res.json({
      count: ops.length,
      operations: ops,
      requestId: req.requestId,
    });
  } catch (e: any) {
    const mapped = mapErrorToHttp(e);
    return res.status(mapped.status).json({ error: mapped.message, details: mapped.details, requestId: req.requestId });
  }
});

app.get("/tools", (req, res) => {
  try {
    requireServerKey(req);
    return res.json({
      tools: [
        { name: "genesys.describe", endpoint: "/describe", description: "Describe operation contract and paging metadata." },
        { name: "genesys.call", endpoint: "/call", description: "Execute one validated operation call." },
        { name: "genesys.callAll", endpoint: "/callAll", description: "Execute deterministic paginated operation call." },
        { name: "genesys.searchOperations", endpoint: "/searchOperations", description: "Search catalog for operationIds." },
      ],
      policy: policySnapshot(),
      requestId: req.requestId,
    });
  } catch (e: any) {
    const mapped = mapErrorToHttp(e);
    return res.status(mapped.status).json({ error: mapped.message, details: mapped.details, requestId: req.requestId });
  }
});

app.post("/tools/invoke", async (req, res) => {
  try {
    requireServerKey(req);
    const payload = ensureObject(req.body ?? {}, "tools.invoke payload");
    assertOnlyKeys(payload, ["tool", "input"], "tools.invoke");
    const tool = toNonEmptyString(payload.tool, "tool");
    const input = ensureObject(payload.input ?? {}, "tools.invoke input");
    logInfo("tools.invoke", { requestId: req.requestId ?? "", tool, input: redactForLog(input) });

    if (tool === "genesys.describe") return res.json({ result: await executeDescribe(input), requestId: req.requestId });
    if (tool === "genesys.call") return res.json({ result: await executeCall(input), requestId: req.requestId });
    if (tool === "genesys.callAll") return res.json({ result: await executeCallAll(input), requestId: req.requestId });
    if (tool === "genesys.searchOperations") {
      const query = typeof input.query === "string" ? input.query : "";
      const method = typeof input.method === "string" ? input.method : undefined;
      const tag = typeof input.tag === "string" ? input.tag : undefined;
      const limit = clamp(parsePositiveInt(input.limit, "input.limit") ?? 25, 1, 200);
      const operationsFound = searchOperations(query, method, tag, limit);
      return res.json({ result: { count: operationsFound.length, operations: operationsFound }, requestId: req.requestId });
    }

    throw httpError(404, `Unknown tool '${tool}'.`);
  } catch (e: any) {
    const mapped = mapErrorToHttp(e);
    return res.status(mapped.status).json({ error: mapped.message, details: mapped.details, requestId: req.requestId });
  }
});

const port = readIntEnv("PORT", 8787, 1, 65535);
const server = app.listen(port, () => {
  logInfo("server.started", {
    port,
    allowWrites: ALLOW_WRITE_OPERATIONS,
    allowlistOperationIds: ALLOWLIST.operationIds.size,
    allowlistTags: ALLOWLIST.tags.size,
    denylistOperationIds: DENYLIST.operationIds.size,
    denylistTags: DENYLIST.tags.size,
    serverManagedCredentials: SERVER_CLIENT_CONFIG !== null,
    allowClientOverrides: ALLOW_CLIENT_OVERRIDES,
  });
  logInfo("server.note", {
    message: "This is an HTTP surface. For protocol-native MCP, wrap/replace with Streamable HTTP MCP server.",
  });
});

function shutdown(signal: "SIGINT" | "SIGTERM"): void {
  logInfo("server.shutdown", { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
