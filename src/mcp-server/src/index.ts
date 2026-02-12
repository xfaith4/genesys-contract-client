import express from "express";
import axios from "axios";
import fs from "node:fs";
import path from "node:path";

type PagingType = "NEXT_URI"|"NEXT_PAGE"|"CURSOR"|"AFTER"|"PAGE_NUMBER"|"TOTALHITS"|"START_INDEX"|"UNKNOWN";

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
  baseUrl: string;    // https://api.mypurecloud.com
  tokenUrl: string;   // https://login.mypurecloud.com/oauth/token
  clientId: string;
  clientSecret: string;
  scope?: string;
};

const app = express();
app.use(express.json({ limit: "10mb" }));

const REPO_ROOT = path.resolve(process.cwd(), "..", ".."); // src/mcp-server -> repo root
const operations: Record<string, Operation> = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "generated", "operations.json"), "utf8"));
const pagingMap: Record<string, { type: PagingType; itemsPath?: string|null }> = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "generated", "pagination-map.json"), "utf8"));

let tokenCache: { accessToken: string; expiresAt: number; key: string } | null = null;

async function getToken(cfg: ClientConfig): Promise<string> {
  const key = `${cfg.tokenUrl}|${cfg.clientId}`;
  const now = Date.now();
  if (tokenCache && tokenCache.key === key && tokenCache.expiresAt > (now + 60_000)) return tokenCache.accessToken;

  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  if (cfg.scope) body.set("scope", cfg.scope);

  const resp = await axios.post(cfg.tokenUrl, body.toString(), {
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  const accessToken = resp.data?.access_token;
  const expiresIn = Number(resp.data?.expires_in ?? 1800);
  if (!accessToken) throw new Error("Token response missing access_token");

  tokenCache = { accessToken, expiresAt: now + expiresIn * 1000, key };
  return accessToken;
}

function assertParams(op: Operation, params: Record<string, unknown>) {
  const declared = new Set(op.parameters.filter(p => p.in === "query" || p.in === "path").map(p => p.name));
  const required = op.parameters.filter(p => (p.in === "query" || p.in === "path") && p.required).map(p => p.name);

  for (const r of required) {
    if (!(r in params)) throw new Error(`Missing required parameter '${r}' for operationId '${op.operationId}'.`);
  }
  for (const k of Object.keys(params)) {
    if (!declared.has(k)) throw new Error(`Unknown parameter '${k}' for operationId '${op.operationId}'. Refusing to guess.`);
  }
}

function buildUrl(cfg: ClientConfig, op: Operation, params: Record<string, any>): string {
  let p = op.path;
  for (const prm of op.parameters.filter(x => x.in === "path")) {
    if (!(prm.name in params)) throw new Error(`Missing required path param '${prm.name}'.`);
    p = p.replace(`{${prm.name}}`, encodeURIComponent(String(params[prm.name])));
  }
  const qs = new URLSearchParams();
  for (const prm of op.parameters.filter(x => x.in === "query")) {
    if (prm.name in params && params[prm.name] !== null && params[prm.name] !== undefined) {
      qs.set(prm.name, String(params[prm.name]));
    }
  }
  const base = cfg.baseUrl.replace(/\/$/, "");
  const q = qs.toString();
  return q ? `${base}${p}?${q}` : `${base}${p}`;
}

function getItems(resp: any): any[] {
  if (!resp) return [];
  if (Array.isArray(resp.entities)) return resp.entities;
  if (Array.isArray(resp.results)) return resp.results;
  // fallback: first array property
  for (const [k,v] of Object.entries(resp)) {
    if (Array.isArray(v)) return v as any[];
  }
  return [];
}

async function callOnce(cfg: ClientConfig, op: Operation, params: Record<string, any>, body?: any, overrideUrl?: string): Promise<any> {
  const token = await getToken(cfg);
  const url = overrideUrl ?? buildUrl(cfg, op, params);
  const method = overrideUrl ? "GET" : op.method;
  const resp = await axios.request({
    method,
    url,
    headers: { Authorization: `Bearer ${token}` },
    data: (method === "POST" || method === "PUT" || method === "PATCH") ? body : undefined
  });
  return resp.data;
}

// HTTP endpoints (Strider admins can wrap into MCP tooling)
app.post("/describe", (req, res) => {
  const { operationId } = req.body ?? {};
  const op = operations[operationId];
  if (!op) return res.status(404).json({ error: "unknown operationId" });
  return res.json({ operation: op, paging: pagingMap[operationId] ?? { type: op.pagingType, itemsPath: op.responseItemsPath } });
});

app.post("/call", async (req, res) => {
  try {
    const { client, operationId, params = {}, body = null } = req.body ?? {};
    const op = operations[operationId];
    if (!op) return res.status(404).json({ error: "unknown operationId" });
    assertParams(op, params);
    const data = await callOnce(client, op, params, body);
    return res.json({ data });
  } catch (e: any) {
    return res.status(400).json({ error: e?.message ?? String(e) });
  }
});

app.post("/callAll", async (req, res) => {
  try {
    const { client, operationId, params = {}, body = null, pageSize = 100, limit = 0, maxPages = 0 } = req.body ?? {};
    const op = operations[operationId];
    if (!op) return res.status(404).json({ error: "unknown operationId" });
    assertParams(op, params);

    const map = pagingMap[operationId] ?? { type: op.pagingType, itemsPath: op.responseItemsPath };
    const ptype: PagingType = map.type;
    if (ptype === "UNKNOWN") throw new Error(`Unknown pagination type for ${operationId}. Add to registry or regenerate.`);

    const items: any[] = [];
    const audit: any[] = [];
    let page = 1;
    let next: string | null = null;
    let cursor: string | null = null;
    let after: string | null = null;
    let pageNumber = 1;

    while (true) {
      if (maxPages && page > maxPages) { audit.push({ page, stop: "maxPages" }); break; }

      const localParams = { ...params };
      let localBody: any = body;

      if (ptype === "PAGE_NUMBER") {
        if (op.parameters.some(p => p.in === "query" && p.name === "pageNumber")) {
          localParams.pageNumber = pageNumber;
          localParams.pageSize = pageSize;
        } else {
          localBody = localBody ?? {};
          localBody.paging = { pageNumber, pageSize };
        }
      } else if (ptype === "CURSOR" && cursor) {
        if (op.parameters.some(p => p.in === "query" && p.name === "cursor")) localParams.cursor = cursor;
        else { localBody = localBody ?? {}; localBody.cursor = cursor; }
      } else if (ptype === "AFTER" && after) {
        if (op.parameters.some(p => p.in === "query" && p.name === "after")) localParams.after = after;
        else { localBody = localBody ?? {}; localBody.after = after; }
      }

      const data = await callOnce(client, op, localParams, localBody, next ?? undefined);
      const batch = getItems(data);
      items.push(...batch);
      audit.push({
        page, fetched: batch.length, total: items.length,
        nextUri: data?.nextUri ?? null, nextPage: data?.nextPage ?? null,
        cursor: data?.cursor ?? null, after: data?.after ?? null,
        pageNumber: data?.pageNumber ?? null, pageCount: data?.pageCount ?? null
      });

      if (limit && items.length >= limit) break;
      if (batch.length === 0) break;

      next = null;
      if (ptype === "NEXT_URI") { next = data?.nextUri ?? null; if (!next) break; }
      else if (ptype === "NEXT_PAGE") { next = data?.nextPage ?? null; if (!next) break; }
      else if (ptype === "CURSOR") { cursor = data?.cursor ?? null; if (!cursor) break; }
      else if (ptype === "AFTER") { after = data?.after ?? null; if (!after) break; }
      else if (ptype === "PAGE_NUMBER") {
        const pn = Number(data?.pageNumber ?? 0);
        const pc = Number(data?.pageCount ?? 0);
        if (pc && pn && pn >= pc) break;
        pageNumber++;
      } else if (ptype === "TOTALHITS") {
        const th = Number(data?.totalHits ?? 0);
        if (!th) break;
        if (pageNumber * pageSize >= th) break;
        pageNumber++;
      }

      page++;
    }

    return res.json({ operationId, pagingType: ptype, items, audit });
  } catch (e: any) {
    return res.status(400).json({ error: e?.message ?? String(e) });
  }
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`genesys-contract-client server listening on :${port}`);
  console.log("NOTE: This is an HTTP surface. Wrap into MCP tooling as needed.");
});
