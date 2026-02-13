import fs from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { JsonObject, LoggingPolicy, LoggingPolicyRule, Operation, PolicyList } from "./types.js";
import { isPlainObject } from "./utils.js";

const DEFAULT_REDACTION_FIELDS = [
  "authorization",
  "access_token",
  "refresh_token",
  "id_token",
  "token",
  "secret",
  "password",
];

function normalizeYamlList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v) => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => !!v);
}

function readYamlOrDefault(filePath: string, defaultValue: unknown): unknown {
  if (!fs.existsSync(filePath)) return defaultValue;
  const text = fs.readFileSync(filePath, "utf8");
  const parsed = parseYaml(text);
  return parsed ?? defaultValue;
}

export function loadPolicyList(repoRoot: string, fileName: string): PolicyList {
  const yamlPath = path.join(repoRoot, "registry", fileName);
  const parsed = readYamlOrDefault(yamlPath, []);
  const rows = normalizeYamlList(parsed);

  const operationIds = new Set<string>();
  const tags = new Set<string>();
  for (const row of rows) {
    if (row.toLowerCase().startsWith("tag:")) {
      const tag = row.slice(4).trim().toLowerCase();
      if (tag) tags.add(tag);
      continue;
    }
    operationIds.add(row);
  }

  return {
    operationIds,
    tags,
    hasEntries: operationIds.size > 0 || tags.size > 0,
  };
}

export function loadSimpleList(repoRoot: string, fileName: string): Set<string> {
  const yamlPath = path.join(repoRoot, "registry", fileName);
  const parsed = readYamlOrDefault(yamlPath, []);
  const rows = normalizeYamlList(parsed);
  return new Set(rows.map((x) => x.toLowerCase()));
}

function normalizeRule(value: unknown): LoggingPolicyRule {
  if (!isPlainObject(value)) return { params: [], bodyPaths: [] };
  const params = normalizeYamlList(value.params);
  const bodyPaths = normalizeYamlList(value.bodyPaths);
  return { params, bodyPaths };
}

export function loadLoggingPolicy(repoRoot: string): LoggingPolicy {
  const yamlPath = path.join(repoRoot, "registry", "logging-policy.yaml");
  const parsed = readYamlOrDefault(yamlPath, {});
  if (!isPlainObject(parsed)) {
    return { defaultRule: { params: [], bodyPaths: [] }, operationRules: new Map() };
  }

  const defaultRule = normalizeRule(parsed.default);
  const operationRules = new Map<string, LoggingPolicyRule>();

  if (isPlainObject(parsed.operations)) {
    for (const [operationId, rule] of Object.entries(parsed.operations)) {
      operationRules.set(operationId, normalizeRule(rule));
    }
  }

  return { defaultRule, operationRules };
}

export function operationMatchesPolicy(op: Operation, policy: PolicyList): boolean {
  if (policy.operationIds.has(op.operationId)) return true;
  const tags = op.tags ?? [];
  for (const t of tags) {
    if (policy.tags.has(String(t).toLowerCase())) return true;
  }
  return false;
}

export function loadRedactionFields(repoRoot: string): Set<string> {
  const extra = [...loadSimpleList(repoRoot, "pii-redaction.yaml")];
  return new Set([...DEFAULT_REDACTION_FIELDS, ...extra]);
}

export function redactForLog(value: unknown, redactionFields: Set<string>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((x) => redactForLog(x, redactionFields));
  if (!isPlainObject(value)) return "[non-plain-object]";

  const out: JsonObject = {};
  for (const [k, v] of Object.entries(value)) {
    const key = k.toLowerCase();
    const shouldRedact = redactionFields.has(key) || key.includes("secret") || key.includes("token") || key.includes("password");
    out[k] = shouldRedact ? "***redacted***" : redactForLog(v, redactionFields);
  }
  return out;
}

function tokenizePath(jsonPath: string): string[] {
  const trimmed = jsonPath.trim();
  const normalized = trimmed.startsWith("$.") ? trimmed.slice(2) : trimmed.startsWith("$") ? trimmed.slice(1) : trimmed;
  if (!normalized) return [];

  const tokens: string[] = [];
  for (const chunk of normalized.split(".")) {
    if (!chunk) continue;
    const m = /^([^\[]+)(\[(\d+)\])?$/.exec(chunk);
    if (!m) return [];
    tokens.push(m[1]);
    if (m[3] !== undefined) tokens.push(m[3]);
  }
  return tokens;
}

function getValueAtPath(obj: unknown, jsonPath: string): unknown {
  const tokens = tokenizePath(jsonPath);
  if (tokens.length === 0) return undefined;

  let cursor: unknown = obj;
  for (const token of tokens) {
    if (Array.isArray(cursor)) {
      const idx = Number(token);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) return undefined;
      cursor = cursor[idx];
      continue;
    }

    if (!isPlainObject(cursor)) return undefined;
    if (!(token in cursor)) return undefined;
    cursor = cursor[token];
  }
  return cursor;
}

export function summarizeRequest(
  operationId: string,
  params: JsonObject | undefined,
  body: unknown,
  loggingPolicy: LoggingPolicy,
  redactionFields: Set<string>,
): JsonObject {
  const rule = loggingPolicy.operationRules.get(operationId) ?? loggingPolicy.defaultRule;
  const summary: JsonObject = {};

  if (rule.params.length > 0) {
    const picked: JsonObject = {};
    const source = params ?? {};
    for (const key of rule.params) {
      if (key in source) {
        picked[key] = source[key];
      }
    }
    summary.params = redactForLog(picked, redactionFields);
  }

  if (rule.bodyPaths.length > 0) {
    const picked: JsonObject = {};
    for (const bodyPath of rule.bodyPaths) {
      const value = getValueAtPath(body, bodyPath);
      if (value !== undefined) {
        picked[bodyPath] = value;
      }
    }
    summary.body = redactForLog(picked, redactionFields);
  }

  return summary;
}

