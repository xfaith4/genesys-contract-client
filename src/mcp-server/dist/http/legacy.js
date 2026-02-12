import { assertOnlyKeys, ensureObject, parseBoolean, parsePositiveInt, toNonEmptyString } from "../core/utils.js";
export function registerLegacyHttpRoutes(app, core) {
    app.post("/describe", async (req, res) => {
        try {
            core.requireServerKey(String(req.header("x-server-key") || ""));
            const payload = ensureObject(req.body ?? {}, "describe payload");
            assertOnlyKeys(payload, ["operationId"], "describe");
            const response = await core.describe({
                operationId: toNonEmptyString(payload.operationId, "operationId"),
            });
            return res.json({ ...response, requestId: req.requestId });
        }
        catch (e) {
            const mapped = core.mapErrorToHttp(e);
            return res.status(mapped.status).json({ error: mapped.message, details: mapped.details, requestId: req.requestId });
        }
    });
    app.post("/call", async (req, res) => {
        try {
            core.requireServerKey(String(req.header("x-server-key") || ""));
            const payload = ensureObject(req.body ?? {}, "call payload");
            assertOnlyKeys(payload, ["client", "operationId", "params", "body"], "call");
            const operationId = toNonEmptyString(payload.operationId, "operationId");
            const params = payload.params === undefined ? {} : ensureObject(payload.params, "params");
            const body = payload.body ?? null;
            if (core.config.logRequestPayloads) {
                const summary = core.summarizeRequest(operationId, params, body);
                console.log(JSON.stringify({ event: "legacy.call.request", requestId: req.requestId, operationId, summary }));
            }
            const response = await core.call({
                client: payload.client,
                operationId,
                params,
                body,
            });
            return res.json({ ...response, requestId: req.requestId });
        }
        catch (e) {
            const mapped = core.mapErrorToHttp(e);
            return res.status(mapped.status).json({ error: mapped.message, details: mapped.details, requestId: req.requestId });
        }
    });
    app.post("/callAll", async (req, res) => {
        try {
            core.requireServerKey(String(req.header("x-server-key") || ""));
            const payload = ensureObject(req.body ?? {}, "callAll payload");
            assertOnlyKeys(payload, ["client", "operationId", "params", "body", "pageSize", "limit", "maxPages", "maxRuntimeMs", "includeItems"], "callAll");
            const operationId = toNonEmptyString(payload.operationId, "operationId");
            const params = payload.params === undefined ? {} : ensureObject(payload.params, "params");
            const body = payload.body ?? null;
            if (core.config.logRequestPayloads) {
                const summary = core.summarizeRequest(operationId, params, body);
                console.log(JSON.stringify({
                    event: "legacy.callAll.request",
                    requestId: req.requestId,
                    operationId,
                    pageSize: payload.pageSize,
                    limit: payload.limit,
                    maxPages: payload.maxPages,
                    maxRuntimeMs: payload.maxRuntimeMs,
                    summary,
                }));
            }
            const response = await core.callAll({
                client: payload.client,
                operationId,
                params,
                body,
                pageSize: parsePositiveInt(payload.pageSize, "pageSize"),
                limit: parsePositiveInt(payload.limit, "limit"),
                maxPages: parsePositiveInt(payload.maxPages, "maxPages"),
                maxRuntimeMs: parsePositiveInt(payload.maxRuntimeMs, "maxRuntimeMs"),
                includeItems: parseBoolean(payload.includeItems, "includeItems"),
            });
            return res.json({ ...response, requestId: req.requestId });
        }
        catch (e) {
            const mapped = core.mapErrorToHttp(e);
            return res.status(mapped.status).json({ error: mapped.message, details: mapped.details, requestId: req.requestId });
        }
    });
    app.post("/searchOperations", async (req, res) => {
        try {
            core.requireServerKey(String(req.header("x-server-key") || ""));
            const payload = ensureObject(req.body ?? {}, "searchOperations payload");
            assertOnlyKeys(payload, ["query", "method", "tag", "limit"], "searchOperations");
            const response = core.searchOperations({
                query: typeof payload.query === "string" ? payload.query : "",
                method: typeof payload.method === "string" ? payload.method : undefined,
                tag: typeof payload.tag === "string" ? payload.tag : undefined,
                limit: parsePositiveInt(payload.limit, "limit"),
            });
            return res.json({ ...response, requestId: req.requestId });
        }
        catch (e) {
            const mapped = core.mapErrorToHttp(e);
            return res.status(mapped.status).json({ error: mapped.message, details: mapped.details, requestId: req.requestId });
        }
    });
    app.get("/tools", (req, res) => {
        try {
            core.requireServerKey(String(req.header("x-server-key") || ""));
            return res.json({
                tools: [
                    { name: "genesys.describe", endpoint: "/describe", description: "Describe operation contract and paging metadata." },
                    { name: "genesys.call", endpoint: "/call", description: "Execute one validated operation call." },
                    { name: "genesys.callAll", endpoint: "/callAll", description: "Execute deterministic paginated operation call." },
                    { name: "genesys.searchOperations", endpoint: "/searchOperations", description: "Search catalog for operationIds." },
                ],
                policy: core.getPolicySnapshot(),
                requestId: req.requestId,
            });
        }
        catch (e) {
            const mapped = core.mapErrorToHttp(e);
            return res.status(mapped.status).json({ error: mapped.message, details: mapped.details, requestId: req.requestId });
        }
    });
    app.post("/tools/invoke", async (req, res) => {
        try {
            core.requireServerKey(String(req.header("x-server-key") || ""));
            const payload = ensureObject(req.body ?? {}, "tools.invoke payload");
            assertOnlyKeys(payload, ["tool", "input"], "tools.invoke");
            const tool = toNonEmptyString(payload.tool, "tool");
            const input = ensureObject(payload.input ?? {}, "tools.invoke input");
            if (tool === "genesys.describe") {
                const response = await core.describe({ operationId: toNonEmptyString(input.operationId, "input.operationId") });
                return res.json({ result: response, requestId: req.requestId });
            }
            if (tool === "genesys.call") {
                const params = input.params === undefined ? {} : ensureObject(input.params, "input.params");
                const response = await core.call({
                    client: input.client,
                    operationId: toNonEmptyString(input.operationId, "input.operationId"),
                    params,
                    body: input.body ?? null,
                });
                return res.json({ result: response, requestId: req.requestId });
            }
            if (tool === "genesys.callAll") {
                const params = input.params === undefined ? {} : ensureObject(input.params, "input.params");
                const response = await core.callAll({
                    client: input.client,
                    operationId: toNonEmptyString(input.operationId, "input.operationId"),
                    params,
                    body: input.body ?? null,
                    pageSize: parsePositiveInt(input.pageSize, "input.pageSize"),
                    limit: parsePositiveInt(input.limit, "input.limit"),
                    maxPages: parsePositiveInt(input.maxPages, "input.maxPages"),
                    maxRuntimeMs: parsePositiveInt(input.maxRuntimeMs, "input.maxRuntimeMs"),
                    includeItems: parseBoolean(input.includeItems, "input.includeItems"),
                });
                return res.json({ result: response, requestId: req.requestId });
            }
            if (tool === "genesys.searchOperations") {
                const response = core.searchOperations({
                    query: typeof input.query === "string" ? input.query : "",
                    method: typeof input.method === "string" ? input.method : undefined,
                    tag: typeof input.tag === "string" ? input.tag : undefined,
                    limit: parsePositiveInt(input.limit, "input.limit"),
                });
                return res.json({ result: response, requestId: req.requestId });
            }
            return res.status(404).json({ error: `Unknown tool '${tool}'.`, requestId: req.requestId });
        }
        catch (e) {
            const mapped = core.mapErrorToHttp(e);
            return res.status(mapped.status).json({ error: mapped.message, details: mapped.details, requestId: req.requestId });
        }
    });
}
