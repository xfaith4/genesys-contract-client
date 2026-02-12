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

type Operation = {
  operationId: string;
  method: string;
  path: string;
  tags: string[];
  parameters: { name: string; in: string; required: boolean }[];
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

// ---- Server config (trust boundary) ----------------------------------------
// If SERVER_API_KEY is set, every request must include header: X-Server-Key
const SERVER_API_KEY = process.env.SERVER_API_KEY || "";

// If ALLOW_WRITE_OPERATIONS is not "true", non-GET operations are denied unless explicitly allowlisted.
const ALLOW_WRITE_OPERATIONS = (process.env.ALLOW_WRITE_OPERATIONS || "").toLowerCase() === "true";

// Default safety caps for callAll (can be overridden per-request, but never exceed hard caps)
const DEFAULT_PAGE_SIZE = Number(process.env.DEFAULT_PAGE_SIZE || 100);
const DEFAULT_LIMIT = Number(process.env.DEFAULT_LIMIT || 5000);
const DEFAULT_MAX_PAGES = Number(process.env.DEFAULT_MAX_PAGES || 50);
const HARD_MAX_LIMIT = Number(process.env.HARD_MAX_LIMIT || 100000);
const HARD_MAX_PAGES = Number(process.env.HARD_MAX_PAGES || 500);
const HARD_MAX_RUNTIME_MS = Number(process.env.HARD_MAX_RUNTIME_MS || 120_000);

// Network safety
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 30_000);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 5);

const app = express();
app.use(express.json({ limit: "10mb" }));

// Resolve repo root robustly under ESM + compiled dist
const HERE = path.dirname(fileURLToPath(import.meta.url));
// dist/index.js -> src/mcp-server/dist -> repo root is ../../..
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

const operations = readJson<Record<string, Operation>>(path.join(REPO_ROOT, "generated", "operations.json"));
const pagingMap = readJson<Record<string, PagingMapEntry>>(path.join(REPO_ROOT, "generated", "pagination-map.json"));

function loadAllowlistOperationIds(): Set<string> {
  // Minimal YAML parsing: collect any list items starting with "-" (ignore comments/blank).
  // Example allowlist.yaml:
  // ---
  // - getUsers
  // - postAnalyticsConversationsDetailsQuery
  const p = path.join(REPO_ROOT, "registry", "allowlist.yaml");
  if (!fs.existsSync(p)) return new Set();
  const text = fs.readFileSync(p, "utf8");
  const ids = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t === "---") continue;
    if (t.startsWith("-")) {
      const id = t.slice(1).trim();
      if (id) ids.add(id);
    }
  }
  return ids;
}

const ALLOWLIST_OPS = loadAllowlistOperationIds();

function requireServerKey(req: express.Request): void {
  if (!SERVER_API_KEY) return; // local/dev mode
  const key = String(req.header("x-server-key") || "");
  if (key !== SERVER_API_KEY) {
    const err: any = new Error("Unauthorized: missing/invalid X-Server-Key");
    err.statusCode = 401;
    throw err;
  }
}

function isOperationAllowed(op: Operation): boolean {
  if (ALLOWLIST_OPS.size > 0) {
    return ALLOWLIST_OPS.has(op.operationId);
  }
  // Default stance if allowlist is empty: allow reads, block writes unless explicitly enabled.
  if (op.method.toUpperCase() === "GET") return true;
  if (!ALLOW_WRITE_OPERATIONS) return false;
  // even with ALLOW_WRITE_OPERATIONS, you should probably still maintain a allowlist,
  // but this escape hatch is useful for dev.
  return true;
}

// ---- Token cache (safe-ish) -------------------------------------------------
// Cache key includes tokenUrl, clientId, scope, and a hash of the secret.
let tokenCache: { accessToken: string; expiresAt: number; key: string } | null = null;

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
      const retryable = status === 429 || status === 502 || status === 503 || status === 504;
      if (!retryable || attempt >= MAX_RETRIES) throw err;

      const retryAfter = Number(err.response?.headers?.["retry-after"] || 0);
      const backoff = retryAfter > 0 ? retryAfter * 1000 : Math.min(10_000, 250 * (2 ** (attempt - 1)));
      await sleep(backoff);
    }
  }
}

async function getToken(cfg: ClientConfig): Promise<string> {
  const key = `${cfg.tokenUrl}|${cfg.clientId}|${cfg.scope || ""}|${secretHash(cfg.clientSecret)}`;
  const now = Date.now();
  if (tokenCache && tokenCache.key === key && tokenCache.expiresAt > now + 60_000) return tokenCache.accessToken;

  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  if (cfg.scope) body.set("scope", cfg.scope);

  const data = await requestWithRetry<any>({
    method: "POST",
    url: cfg.tokenUrl,
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    data: body.toString(),
  });

  const accessToken = data?.access_token;
  const expiresIn = Number(data?.expires_in ?? 1800);
  if (!accessToken) {
    const err: any = new Error("Token response missing access_token");
    err.statusCode = 502;
    throw err;
  }

  tokenCache = { accessToken, expiresAt: now + expiresIn * 1000, key };
  return accessToken;
}

// ---- Contract checks (strict-ish) ------------------------------------------
function assertParams(op: Operation, params: Record<string, unknown>) {
  const declared = new Set(op.parameters.filter((p) => p.in === "query" || p.in === "path").map((p) => p.name));
  const required = op.parameters.filter((p) => (p.in === "query" || p.in === "path") && p.required).map((p) => p.name);

  for (const r of required) {
    if (!(r in params)) throw new Error(`Missing required parameter '${r}' for operationId '${op.operationId}'.`);
    const v: any = (params as any)[r];
    if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) {
      throw new Error(`Required parameter '${r}' for operationId '${op.operationId}' is null/empty.`);
    }
  }

  for (const k of Object.keys(params)) {
    if (!declared.has(k)) throw new Error(`Unknown parameter '${k}' for operationId '${op.operationId}'. Refusing to guess.`);
  }
}

function buildUrl(cfg: ClientConfig, op: Operation, params: Record<string, any>): string {
  let p = op.path;
  for (const prm of op.parameters.filter((x) => x.in === "path")) {
    if (!(prm.name in params)) throw new Error(`Missing required path param '${prm.name}'.`);
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
  // Works for absolute and relative URLs.
  return new URL(next, cfg.baseUrl).toString();
}

function assertSameHost(cfg: ClientConfig, url: string) {
  const base = new URL(cfg.baseUrl);
  const u = new URL(url);
  if (u.origin !== base.origin) {
    const err: any = new Error(`Refusing to follow pagination link off-host: ${u.origin} (expected ${base.origin})`);
    err.statusCode = 400;
    throw err;
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
    if (ok && Array.isArray(cur)) return cur;
  }

  // last resort: first array property
  for (const [, v] of Object.entries(resp)) {
    if (Array.isArray(v)) return v as any[];
  }
  return [];
}

async function callOnce(cfg: ClientConfig, op: Operation, params: Record<string, any>, body?: any, overrideUrl?: string): Promise<any> {
  const token = await getToken(cfg);

  const url = overrideUrl ? resolveNextUrl(cfg, overrideUrl) : buildUrl(cfg, op, params);
  assertSameHost(cfg, url);

  const method = overrideUrl ? "GET" : op.method.toUpperCase();

  const data = await requestWithRetry<any>({
    method,
    url,
    headers: { Authorization: `Bearer ${token}` },
    data: method === "POST" || method === "PUT" || method === "PATCH" ? body : undefined,
  });

  return data;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function mapErrorToHttp(e: any): { status: number; message: string; details?: any } {
  if (e?.statusCode) return { status: Number(e.statusCode), message: e.message ?? String(e) };

  const err = e as AxiosError;
  const status = err.response?.status;
  if (status) {
    const msg = (err.response?.data as any)?.message || err.message;
    return { status, message: msg, details: err.response?.data };
  }

  return { status: 500, message: e?.message ?? String(e) };
}

// ---- HTTP endpoints (can be wrapped by an MCP adapter) ----------------------
app.post("/describe", (req, res) => {
  try {
    requireServerKey(req);
    const { operationId } = req.body ?? {};
    const op = operations[operationId];
    if (!op) return res.status(404).json({ error: "unknown operationId" });

    if (!isOperationAllowed(op)) return res.status(403).json({ error: "operationId not allowed by server policy" });

    return res.json({
      operation: op,
      paging: pagingMap[operationId] ?? { type: op.pagingType, itemsPath: op.responseItemsPath },
      policy: {
        allowlistCount: ALLOWLIST_OPS.size,
        allowWrites: ALLOW_WRITE_OPERATIONS,
      },
    });
  } catch (e: any) {
    const mapped = mapErrorToHttp(e);
    return res.status(mapped.status).json({ error: mapped.message });
  }
});

app.post("/call", async (req, res) => {
  try {
    requireServerKey(req);
    const { client, operationId, params = {}, body = null } = req.body ?? {};
    const op = operations[operationId];
    if (!op) return res.status(404).json({ error: "unknown operationId" });

    if (!isOperationAllowed(op)) return res.status(403).json({ error: "operationId not allowed by server policy" });

    assertParams(op, params);
    const data = await callOnce(client, op, params, body);
    return res.json({ data });
  } catch (e: any) {
    const mapped = mapErrorToHttp(e);
    return res.status(mapped.status).json({ error: mapped.message, details: mapped.details });
  }
});

app.post("/callAll", async (req, res) => {
  const startedAt = Date.now();
  try {
    requireServerKey(req);

    const { client, operationId, params = {}, body = null } = req.body ?? {};
    const reqPageSize = Number(req.body?.pageSize ?? DEFAULT_PAGE_SIZE);
    const reqLimit = Number(req.body?.limit ?? DEFAULT_LIMIT);
    const reqMaxPages = Number(req.body?.maxPages ?? DEFAULT_MAX_PAGES);

    const pageSize = clamp(reqPageSize || DEFAULT_PAGE_SIZE, 1, 1000);
    const limit = clamp(reqLimit || DEFAULT_LIMIT, 1, HARD_MAX_LIMIT);
    const maxPages = clamp(reqMaxPages || DEFAULT_MAX_PAGES, 1, HARD_MAX_PAGES);

    const op = operations[operationId];
    if (!op) return res.status(404).json({ error: "unknown operationId" });

    if (!isOperationAllowed(op)) return res.status(403).json({ error: "operationId not allowed by server policy" });

    assertParams(op, params);

    const map = pagingMap[operationId] ?? { type: op.pagingType, itemsPath: op.responseItemsPath };
    const ptype: PagingType = map.type;
    const itemsPath = map.itemsPath ?? op.responseItemsPath ?? "$.entities";

    if (ptype === "UNKNOWN") throw new Error(`Unknown pagination type for ${operationId}. Add to registry or regenerate.`);

    const items: any[] = [];
    const audit: any[] = [];

    let page = 1;
    let next: string | null = null;
    let cursor: string | null = null;
    let after: string | null = null;
    let pageNumber = 1;

    while (true) {
      if (Date.now() - startedAt > HARD_MAX_RUNTIME_MS) {
        audit.push({ page, stop: "maxRuntimeMs", maxRuntimeMs: HARD_MAX_RUNTIME_MS });
        break;
      }
      if (page > maxPages) {
        audit.push({ page, stop: "maxPages", maxPages });
        break;
      }

      const localParams = { ...params };
      let localBody: any = body;

      if (ptype === "PAGE_NUMBER") {
        if (op.parameters.some((p) => p.in === "query" && p.name === "pageNumber")) {
          localParams.pageNumber = pageNumber;
          localParams.pageSize = pageSize;
        } else {
          localBody = localBody ?? {};
          localBody.paging = { pageNumber, pageSize };
        }
      } else if (ptype === "CURSOR" && cursor) {
        if (op.parameters.some((p) => p.in === "query" && p.name === "cursor")) localParams.cursor = cursor;
        else {
          localBody = localBody ?? {};
          localBody.cursor = cursor;
        }
      } else if (ptype === "AFTER" && after) {
        if (op.parameters.some((p) => p.in === "query" && p.name === "after")) localParams.after = after;
        else {
          localBody = localBody ?? {};
          localBody.after = after;
        }
      }

      const data = await callOnce(client, op, localParams, localBody, next ?? undefined);
      const batch = getItemsByPath(data, itemsPath);

      items.push(...batch);

      audit.push({
        page,
        fetched: batch.length,
        total: items.length,
        pagingType: ptype,
        itemsPath,
        nextUri: data?.nextUri ?? null,
        nextPage: data?.nextPage ?? null,
        cursor: data?.cursor ?? null,
        after: data?.after ?? null,
        pageNumber: data?.pageNumber ?? null,
        pageCount: data?.pageCount ?? null,
        totalHits: data?.totalHits ?? null,
      });

      if (items.length >= limit) {
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
      } else if (ptype === "NEXT_PAGE") {
        next = data?.nextPage ?? null;
        if (!next) {
          audit.push({ page, stop: "missingNextPage" });
          break;
        }
      } else if (ptype === "CURSOR") {
        cursor = data?.cursor ?? null;
        if (!cursor) {
          audit.push({ page, stop: "missingCursor" });
          break;
        }
      } else if (ptype === "AFTER") {
        after = data?.after ?? null;
        if (!after) {
          audit.push({ page, stop: "missingAfter" });
          break;
        }
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

    return res.json({ operationId, pagingType: ptype, itemsPath, limit, maxPages, pageSize, items, audit });
  } catch (e: any) {
    const mapped = mapErrorToHttp(e);
    return res.status(mapped.status).json({ error: mapped.message, details: mapped.details });
  }
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`genesys-contract-client server listening on :${port}`);
  console.log("NOTE: This is an HTTP surface. For protocol-native MCP, wrap/replace with Streamable HTTP MCP server.");
  if (SERVER_API_KEY) console.log("Server auth: X-Server-Key required.");
  if (ALLOWLIST_OPS.size === 0) console.log("Allowlist: empty (default policy applies: GET only unless ALLOW_WRITE_OPERATIONS=true)");
  else console.log(`Allowlist: ${ALLOWLIST_OPS.size} operationIds.`);
});
