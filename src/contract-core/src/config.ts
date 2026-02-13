import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CoreConfig, Operation, PagingMapEntry } from "./types.js";
import { clamp, parseHostAllowlist, readBoolEnv, readIntEnv } from "./utils.js";

export function resolveRepoRoot(importMetaUrl: string): string {
  const here = path.dirname(fileURLToPath(importMetaUrl));
  return path.resolve(here, "..", "..", "..");
}

export function createCoreConfig(repoRoot: string, overrides: Partial<CoreConfig> = {}): CoreConfig {
  const hardMaxLimit = readIntEnv("HARD_MAX_LIMIT", 100_000, 1, 1_000_000);
  const hardMaxPages = readIntEnv("HARD_MAX_PAGES", 500, 1, 10_000);
  const hardMaxRuntimeMs = readIntEnv("HARD_MAX_RUNTIME_MS", 120_000, 1_000, 900_000);

  const defaultLimit = clamp(readIntEnv("DEFAULT_LIMIT", 5000, 1, hardMaxLimit), 1, hardMaxLimit);
  const defaultMaxPages = clamp(readIntEnv("DEFAULT_MAX_PAGES", 50, 1, hardMaxPages), 1, hardMaxPages);
  const defaultMaxRuntimeMs = clamp(readIntEnv("DEFAULT_MAX_RUNTIME_MS", hardMaxRuntimeMs, 1_000, hardMaxRuntimeMs), 1_000, hardMaxRuntimeMs);

  const base: CoreConfig = {
    repoRoot,
    serverApiKey: process.env.SERVER_API_KEY || "",
    allowWriteOperations: readBoolEnv("ALLOW_WRITE_OPERATIONS", false),
    allowClientOverrides: readBoolEnv("ALLOW_CLIENT_OVERRIDES", false),
    allowInsecureHttp: readBoolEnv("ALLOW_INSECURE_HTTP", false),
    allowArrayFallback: readBoolEnv("ALLOW_ARRAY_FALLBACK", false),
    defaultIncludeItems: readBoolEnv("DEFAULT_INCLUDE_ITEMS", true),
    requestBodyLimit: process.env.REQUEST_BODY_LIMIT || "1mb",
    hardMaxLimit,
    hardMaxPages,
    hardMaxRuntimeMs,
    defaultPageSize: readIntEnv("DEFAULT_PAGE_SIZE", 100, 1, 1000),
    defaultLimit,
    defaultMaxPages,
    defaultMaxRuntimeMs,
    httpTimeoutMs: readIntEnv("HTTP_TIMEOUT_MS", 30_000, 1_000, 180_000),
    maxRetries: readIntEnv("MAX_RETRIES", 5, 1, 12),
    allowedBaseHosts: parseHostAllowlist(process.env.ALLOWED_BASE_HOSTS),
    allowedTokenHosts: parseHostAllowlist(process.env.ALLOWED_TOKEN_HOSTS),
    strictBodySchema: readBoolEnv("STRICT_BODY_SCHEMA", true),
    logRequestPayloads: readBoolEnv("LOG_REQUEST_PAYLOADS", true),
    mcpPath: process.env.MCP_PATH || "/mcp",
    healthPath: process.env.HEALTH_PATH || "/healthz",
    mcpMaxSessions: readIntEnv("MCP_MAX_SESSIONS", 256, 1, 10_000),
    mcpSessionTtlMs: readIntEnv("MCP_SESSION_TTL_MS", 900_000, 1_000, 86_400_000),
    legacyHttpApi: readBoolEnv("LEGACY_HTTP_API", false),
    host: process.env.HOST || "127.0.0.1",
    port: readIntEnv("PORT", 8787, 1, 65535),
  };

  return {
    ...base,
    ...overrides,
  };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function loadOperations(repoRoot: string): Record<string, Operation> {
  return readJson<Record<string, Operation>>(path.join(repoRoot, "generated", "operations.json"));
}

export function loadPagingMap(repoRoot: string): Record<string, PagingMapEntry> {
  return readJson<Record<string, PagingMapEntry>>(path.join(repoRoot, "generated", "pagination-map.json"));
}

export function loadSwaggerDefinitions(repoRoot: string): Record<string, unknown> {
  const swagger = readJson<any>(path.join(repoRoot, "specs", "swagger.json"));
  return (swagger?.definitions ?? {}) as Record<string, unknown>;
}
