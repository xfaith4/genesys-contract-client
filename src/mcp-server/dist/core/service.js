import axios from "axios";
import crypto from "node:crypto";
import { createCoreConfig, loadOperations, loadPagingMap, loadSwaggerDefinitions } from "./config.js";
import { loadLoggingPolicy, loadPolicyList, loadRedactionFields, operationMatchesPolicy, redactForLog, summarizeRequest } from "./policy.js";
import { OperationBodyValidator } from "./schema-validator.js";
import { clamp, constantTimeEqual, ensureObject, httpError, isLoopbackHost, isPlainObject, logInfo, parseRetryAfterMs, redactedPagingValue, sleep, toNonEmptyString, } from "./utils.js";
export class GenesysCoreService {
    config;
    operations;
    pagingMap;
    allowlist;
    denylist;
    loggingPolicy;
    redactionFields;
    definitions;
    bodyValidator;
    tokenCache = new Map();
    http;
    serverClientConfig;
    constructor(repoRoot, options = {}) {
        this.config = createCoreConfig(repoRoot, options.config ?? {});
        this.operations = options.operations ?? loadOperations(this.config.repoRoot);
        this.pagingMap = options.pagingMap ?? loadPagingMap(this.config.repoRoot);
        this.definitions = options.definitions ?? loadSwaggerDefinitions(this.config.repoRoot);
        this.allowlist = loadPolicyList(this.config.repoRoot, "allowlist.yaml");
        this.denylist = loadPolicyList(this.config.repoRoot, "denylist.yaml");
        this.loggingPolicy = loadLoggingPolicy(this.config.repoRoot);
        this.redactionFields = loadRedactionFields(this.config.repoRoot);
        this.bodyValidator = new OperationBodyValidator(this.definitions, this.config.strictBodySchema);
        this.http = axios.create({ timeout: this.config.httpTimeoutMs });
        this.serverClientConfig = this.loadServerClientConfigFromEnv();
    }
    requireServerKey(serverKeyHeader) {
        if (!this.config.serverApiKey)
            return;
        const key = String(serverKeyHeader || "");
        if (!constantTimeEqual(key, this.config.serverApiKey)) {
            throw httpError(401, "Unauthorized: missing/invalid X-Server-Key.");
        }
    }
    getPolicySnapshot() {
        return {
            allowlist: {
                operationIdCount: this.allowlist.operationIds.size,
                tagCount: this.allowlist.tags.size,
            },
            denylist: {
                operationIdCount: this.denylist.operationIds.size,
                tagCount: this.denylist.tags.size,
            },
            allowWrites: this.config.allowWriteOperations,
            serverManagedCredentials: this.serverClientConfig !== null,
            allowClientOverrides: this.config.allowClientOverrides,
        };
    }
    summarizeRequest(operationId, params, body) {
        return summarizeRequest(operationId, params, body, this.loggingPolicy, this.redactionFields);
    }
    redactForLog(value) {
        return redactForLog(value, this.redactionFields);
    }
    mapErrorToHttp(e) {
        const err = e;
        if (err?.statusCode) {
            return { status: Number(err.statusCode), message: err.message ?? String(e), details: err.details };
        }
        const axiosErr = err;
        const status = axiosErr.response?.status;
        if (status) {
            const msg = axiosErr.response?.data?.message || axiosErr.message;
            return { status, message: msg, details: axiosErr.response?.data };
        }
        if (axiosErr.code === "ECONNABORTED") {
            return { status: 504, message: "Upstream request timed out.", details: axiosErr.code };
        }
        return { status: 500, message: err?.message ?? String(e), details: err?.details };
    }
    async describe(input) {
        const operationId = toNonEmptyString(input.operationId, "operationId");
        const op = this.getOp(operationId);
        return {
            operation: op,
            paging: this.getPagingEntry(operationId, op),
            policy: this.getPolicySnapshot(),
        };
    }
    searchOperations(input) {
        const query = input.query.trim().toLowerCase();
        const method = (input.method ?? "").trim().toUpperCase();
        const tag = (input.tag ?? "").trim().toLowerCase();
        const limit = clamp(input.limit ?? 25, 1, 200);
        const out = [];
        for (const op of Object.values(this.operations)) {
            if (!this.isOperationAllowed(op))
                continue;
            if (method && op.method.toUpperCase() !== method)
                continue;
            if (tag && !op.tags.some((x) => String(x).toLowerCase() === tag))
                continue;
            const hay = `${op.operationId} ${op.method} ${op.path} ${(op.summary ?? "")} ${(op.description ?? "")} ${op.tags.join(" ")}`.toLowerCase();
            if (query && !hay.includes(query))
                continue;
            out.push(op);
            if (out.length >= limit)
                break;
        }
        return { count: out.length, operations: out };
    }
    async call(input) {
        const operationId = toNonEmptyString(input.operationId, "operationId");
        const params = input.params === undefined ? {} : ensureObject(input.params, "params");
        const body = input.body ?? null;
        const op = this.getOp(operationId);
        this.assertContract(op, params, body);
        const client = this.resolveClientConfig(input.client);
        const data = await this.callOnce(client, op, params, body);
        return { data };
    }
    async callAll(input) {
        const operationId = toNonEmptyString(input.operationId, "operationId");
        const params = input.params === undefined ? {} : ensureObject(input.params, "params");
        const body = input.body ?? null;
        const op = this.getOp(operationId);
        this.assertContract(op, params, body);
        const pageSize = clamp(input.pageSize ?? this.config.defaultPageSize, 1, 1000);
        const limit = clamp(input.limit ?? this.config.defaultLimit, 1, this.config.hardMaxLimit);
        const maxPages = clamp(input.maxPages ?? this.config.defaultMaxPages, 1, this.config.hardMaxPages);
        const maxRuntimeMs = clamp(input.maxRuntimeMs ?? this.config.defaultMaxRuntimeMs, 1000, this.config.hardMaxRuntimeMs);
        const includeItems = input.includeItems ?? this.config.defaultIncludeItems;
        const map = this.getPagingEntry(operationId, op);
        const ptype = map.type;
        const itemsPath = map.itemsPath ?? op.responseItemsPath ?? "$.entities";
        if (ptype === "UNKNOWN") {
            throw httpError(400, `Unknown pagination type for ${operationId}. Add to registry or regenerate.`);
        }
        const client = this.resolveClientConfig(input.client);
        const items = [];
        const audit = [];
        const seenTokens = new Set();
        let page = 1;
        let next = null;
        let cursor = null;
        let after = null;
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
            const localParams = { ...params };
            let localBody = body;
            if (ptype === "PAGE_NUMBER" || ptype === "TOTALHITS") {
                if (op.parameters.some((p) => p.in === "query" && p.name === "pageNumber")) {
                    localParams.pageNumber = pageNumber;
                    localParams.pageSize = pageSize;
                }
                else {
                    localBody = this.setPagingInBody(localBody, pageNumber, pageSize);
                }
            }
            else if (ptype === "CURSOR" && cursor) {
                if (op.parameters.some((p) => p.in === "query" && p.name === "cursor"))
                    localParams.cursor = cursor;
                else
                    localBody = this.setBodyToken(localBody, "cursor", cursor);
            }
            else if (ptype === "AFTER" && after) {
                if (op.parameters.some((p) => p.in === "query" && p.name === "after"))
                    localParams.after = after;
                else
                    localBody = this.setBodyToken(localBody, "after", after);
            }
            const data = await this.callOnce(client, op, localParams, localBody, next ?? undefined);
            const batch = this.getItemsByPath(data, itemsPath);
            totalFetched += batch.length;
            if (includeItems) {
                const remaining = Math.max(0, limit - items.length);
                if (remaining > 0)
                    items.push(...batch.slice(0, remaining));
            }
            audit.push({
                page,
                fetched: batch.length,
                totalFetched,
                pagingType: ptype,
                itemsPath,
                nextUri: redactedPagingValue(data?.nextUri),
                nextPage: redactedPagingValue(data?.nextPage),
                cursor: redactedPagingValue(data?.cursor),
                after: redactedPagingValue(data?.after),
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
            }
            else if (ptype === "NEXT_PAGE") {
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
            }
            else if (ptype === "CURSOR") {
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
            }
            else if (ptype === "AFTER") {
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
            }
            else if (ptype === "PAGE_NUMBER") {
                const pn = Number(data?.pageNumber ?? 0);
                const pc = Number(data?.pageCount ?? 0);
                if (pc && pn && pn >= pc) {
                    audit.push({ page, stop: "reachedPageCount", pageNumber: pn, pageCount: pc });
                    break;
                }
                pageNumber++;
            }
            else if (ptype === "TOTALHITS") {
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
        return {
            operationId,
            pagingType: ptype,
            itemsPath,
            limit,
            maxPages,
            pageSize,
            maxRuntimeMs,
            totalFetched,
            returnedItems: includeItems ? items.length : 0,
            items: includeItems ? items : [],
            audit,
        };
    }
    logStartup() {
        logInfo("server.started", {
            port: this.config.port,
            host: this.config.host,
            allowWrites: this.config.allowWriteOperations,
            allowlistOperationIds: this.allowlist.operationIds.size,
            allowlistTags: this.allowlist.tags.size,
            denylistOperationIds: this.denylist.operationIds.size,
            denylistTags: this.denylist.tags.size,
            serverManagedCredentials: this.serverClientConfig !== null,
            allowClientOverrides: this.config.allowClientOverrides,
            transport: "mcp-streamable-http",
            legacyHttpApi: this.config.legacyHttpApi,
        });
    }
    loadServerClientConfigFromEnv() {
        const baseUrl = process.env.GENESYS_BASE_URL;
        const tokenUrl = process.env.GENESYS_TOKEN_URL;
        const clientId = process.env.GENESYS_CLIENT_ID;
        const clientSecret = process.env.GENESYS_CLIENT_SECRET;
        const scope = process.env.GENESYS_SCOPE;
        const allUnset = !baseUrl && !tokenUrl && !clientId && !clientSecret && !scope;
        if (allUnset)
            return null;
        if (!baseUrl || !tokenUrl || !clientId || !clientSecret) {
            throw httpError(500, "Server-managed credentials are partially configured. Set GENESYS_BASE_URL, GENESYS_TOKEN_URL, GENESYS_CLIENT_ID, GENESYS_CLIENT_SECRET together.");
        }
        return this.validateClientConfig({
            baseUrl,
            tokenUrl,
            clientId,
            clientSecret,
            scope,
        }, "env");
    }
    validateClientConfig(cfg, source) {
        const baseUrl = toNonEmptyString(cfg.baseUrl, `${source}.baseUrl`);
        const tokenUrl = toNonEmptyString(cfg.tokenUrl, `${source}.tokenUrl`);
        const clientId = toNonEmptyString(cfg.clientId, `${source}.clientId`);
        const clientSecret = toNonEmptyString(cfg.clientSecret, `${source}.clientSecret`);
        const parsedBase = this.parseAndValidateUrl(baseUrl, `${source}.baseUrl`, this.config.allowedBaseHosts);
        const parsedToken = this.parseAndValidateUrl(tokenUrl, `${source}.tokenUrl`, this.config.allowedTokenHosts);
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
    parseAndValidateUrl(raw, fieldName, allowedHosts) {
        let url;
        try {
            url = new URL(raw);
        }
        catch {
            throw httpError(400, `${fieldName} is not a valid URL.`);
        }
        if (url.protocol !== "https:") {
            const allowLoopbackHttp = this.config.allowInsecureHttp && url.protocol === "http:" && isLoopbackHost(url.hostname);
            if (!allowLoopbackHttp) {
                throw httpError(403, `${fieldName} must use https (or loopback http with ALLOW_INSECURE_HTTP=true).`);
            }
        }
        if (allowedHosts.size > 0 && !allowedHosts.has(url.hostname.toLowerCase())) {
            throw httpError(403, `${fieldName} host '${url.hostname}' is not allowlisted.`);
        }
        return url;
    }
    parseClientConfig(input) {
        if (!isPlainObject(input)) {
            throw httpError(400, "client must be an object.");
        }
        return this.validateClientConfig({
            baseUrl: String(input.baseUrl ?? ""),
            tokenUrl: String(input.tokenUrl ?? ""),
            clientId: String(input.clientId ?? ""),
            clientSecret: String(input.clientSecret ?? ""),
            scope: typeof input.scope === "string" ? input.scope : undefined,
        }, "client");
    }
    resolveClientConfig(input) {
        const hasInput = input !== undefined && input !== null;
        if (this.serverClientConfig && !hasInput)
            return this.serverClientConfig;
        if (this.serverClientConfig && hasInput && !this.config.allowClientOverrides) {
            throw httpError(403, "Per-request client credentials are disabled by server policy.");
        }
        if (!this.serverClientConfig && !hasInput) {
            throw httpError(400, "Missing client config. Provide request.client or configure server-managed credentials via GENESYS_* env vars.");
        }
        if (hasInput)
            return this.parseClientConfig(input);
        throw httpError(500, "Unable to resolve client configuration.");
    }
    isOperationAllowed(op) {
        if (this.denylist.hasEntries && operationMatchesPolicy(op, this.denylist))
            return false;
        if (this.allowlist.hasEntries) {
            return operationMatchesPolicy(op, this.allowlist);
        }
        if (op.method.toUpperCase() === "GET")
            return true;
        return this.config.allowWriteOperations;
    }
    getOp(operationId) {
        let op = this.operations[operationId];
        if (!op) {
            for (const candidate of Object.values(this.operations)) {
                if (candidate.operationId === operationId) {
                    op = candidate;
                    break;
                }
            }
        }
        if (!op)
            throw httpError(404, "unknown operationId");
        if (!this.isOperationAllowed(op))
            throw httpError(403, "operationId not allowed by server policy");
        return op;
    }
    getPagingEntry(operationId, op) {
        const direct = this.pagingMap[operationId];
        if (direct)
            return direct;
        const catalogKey = op.catalogKey;
        if (catalogKey && this.pagingMap[catalogKey])
            return this.pagingMap[catalogKey];
        for (const [k, candidate] of Object.entries(this.operations)) {
            if (candidate.operationId === operationId && this.pagingMap[k]) {
                return this.pagingMap[k];
            }
        }
        return { type: op.pagingType, itemsPath: op.responseItemsPath };
    }
    assertParams(op, params) {
        const declared = new Set(op.parameters.filter((p) => p.in === "query" || p.in === "path").map((p) => p.name));
        const required = op.parameters.filter((p) => (p.in === "query" || p.in === "path") && p.required).map((p) => p.name);
        for (const r of required) {
            if (!(r in params))
                throw httpError(400, `Missing required parameter '${r}' for operationId '${op.operationId}'.`);
            const v = params[r];
            if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) {
                throw httpError(400, `Required parameter '${r}' for operationId '${op.operationId}' is null/empty.`);
            }
        }
        for (const k of Object.keys(params)) {
            if (!declared.has(k))
                throw httpError(400, `Unknown parameter '${k}' for operationId '${op.operationId}'. Refusing to guess.`);
        }
    }
    assertBody(op, body) {
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
        if (!bodyParam || body === null || body === undefined)
            return;
        if (!isPlainObject(body) && !Array.isArray(body)) {
            throw httpError(400, `Body for operationId '${op.operationId}' must be an object or array.`);
        }
        if (bodyParam.schema) {
            const errors = this.bodyValidator.validate(op, body);
            if (errors.length > 0) {
                throw httpError(400, `Body schema validation failed for '${op.operationId}'.`, errors.slice(0, 25));
            }
        }
    }
    assertContract(op, params, body) {
        this.assertParams(op, params);
        this.assertBody(op, body);
    }
    buildUrl(cfg, op, params) {
        let p = op.path;
        for (const prm of op.parameters.filter((x) => x.in === "path")) {
            if (!(prm.name in params))
                throw httpError(400, `Missing required path param '${prm.name}'.`);
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
    resolveNextUrl(cfg, next) {
        return new URL(next, cfg.baseUrl).toString();
    }
    assertSameHost(cfg, url) {
        const base = new URL(cfg.baseUrl);
        const u = new URL(url);
        if (u.origin !== base.origin) {
            throw httpError(400, `Refusing to follow pagination link off-host: ${u.origin} (expected ${base.origin})`);
        }
    }
    getItemsByPath(resp, itemsPath) {
        if (!resp)
            return [];
        const tryPaths = [itemsPath, "$.entities", "entities", "$.results", "results"];
        for (const pth of tryPaths) {
            if (!pth)
                continue;
            const normalized = pth.replace(/^\$\./, "").replace(/^\$/, "");
            if (!normalized)
                continue;
            let cur = resp;
            let ok = true;
            for (const seg of normalized.split(".")) {
                if (!seg)
                    continue;
                if (cur && typeof cur === "object" && seg in cur)
                    cur = cur[seg];
                else {
                    ok = false;
                    break;
                }
            }
            if (ok) {
                if (Array.isArray(cur))
                    return cur;
                throw httpError(502, `itemsPath '${pth}' resolved to a non-array value.`);
            }
        }
        if (!this.config.allowArrayFallback)
            return [];
        for (const [, v] of Object.entries(resp)) {
            if (Array.isArray(v))
                return v;
        }
        return [];
    }
    setPagingInBody(body, pageNumber, pageSize) {
        if (body === null || body === undefined) {
            return { paging: { pageNumber, pageSize } };
        }
        if (!isPlainObject(body))
            throw httpError(400, "Body paging requires object body.");
        return { ...body, paging: { pageNumber, pageSize } };
    }
    setBodyToken(body, key, value) {
        if (body === null || body === undefined)
            return { [key]: value };
        if (!isPlainObject(body))
            throw httpError(400, `${key} paging requires object body.`);
        return { ...body, [key]: value };
    }
    async requestWithRetry(cfg) {
        let attempt = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            attempt++;
            try {
                const resp = await this.http.request(cfg);
                return resp.data;
            }
            catch (e) {
                const err = e;
                const status = err.response?.status;
                const retryable = err.response ? status === 408 || status === 429 || status === 502 || status === 503 || status === 504 : true;
                if (!retryable || attempt >= this.config.maxRetries)
                    throw err;
                const retryAfterMs = parseRetryAfterMs(err.response?.headers?.["retry-after"]);
                const backoff = retryAfterMs ?? Math.min(10_000, 250 * (2 ** (attempt - 1)));
                const jitter = Math.floor(Math.random() * 150);
                await sleep(backoff + jitter);
            }
        }
    }
    async getToken(cfg) {
        const key = `${cfg.tokenUrl}|${cfg.clientId}|${cfg.scope || ""}|${this.secretHash(cfg.clientSecret)}`;
        const now = Date.now();
        const cacheEntry = this.tokenCache.get(key);
        if (cacheEntry && cacheEntry.expiresAt > now + 60_000)
            return cacheEntry.accessToken;
        const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
        const body = new URLSearchParams({ grant_type: "client_credentials" });
        if (cfg.scope)
            body.set("scope", cfg.scope);
        const data = await this.requestWithRetry({
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
        this.tokenCache.set(key, { accessToken, expiresAt: now + expiresIn * 1000 });
        return accessToken;
    }
    secretHash(s) {
        return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
    }
    async callOnce(cfg, op, params, body, overrideUrl) {
        const token = await this.getToken(cfg);
        const url = overrideUrl ? this.resolveNextUrl(cfg, overrideUrl) : this.buildUrl(cfg, op, params);
        this.assertSameHost(cfg, url);
        const method = overrideUrl ? "GET" : op.method.toUpperCase();
        return this.requestWithRetry({
            method,
            url,
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/json",
                ...(method === "POST" || method === "PUT" || method === "PATCH" ? { "Content-Type": "application/json" } : {}),
            },
            data: method === "POST" || method === "PUT" || method === "PATCH" ? body : undefined,
        });
    }
}
