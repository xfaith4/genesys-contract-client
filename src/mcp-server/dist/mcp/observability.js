const KEY_SEPARATOR = "\u0001";
const HTTP_LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const MCP_LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];
const SESSION_DURATION_BUCKETS_MS = [1000, 5000, 15000, 60000, 300000, 900000, 3600000];
const RECENT_TOOL_CALL_LIMIT = 200;
function makeHistogram(bucketsMs) {
    return {
        bucketsMs,
        bucketCounts: new Array(bucketsMs.length).fill(0),
        count: 0,
        sumMs: 0,
    };
}
function observeHistogram(histogram, valueMs) {
    histogram.count += 1;
    histogram.sumMs += valueMs;
    for (let idx = 0; idx < histogram.bucketsMs.length; idx += 1) {
        if (valueMs <= histogram.bucketsMs[idx]) {
            histogram.bucketCounts[idx] += 1;
            return;
        }
    }
}
function incrementCounter(map, key, amount = 1) {
    map.set(key, (map.get(key) ?? 0) + amount);
}
function keyOf(...parts) {
    return parts.join(KEY_SEPARATOR);
}
function splitKey(key) {
    return key.split(KEY_SEPARATOR);
}
function label(value) {
    return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n");
}
function toSeconds(ms) {
    return ms / 1000;
}
function truncatedSessionId(sessionId) {
    if (!sessionId)
        return undefined;
    if (sessionId.length <= 12)
        return sessionId;
    return `${sessionId.slice(0, 8)}...${sessionId.slice(-4)}`;
}
export function normalizeErrorClass(mapped) {
    const message = String(mapped.message || "").toLowerCase();
    if (message.includes("cancelled") || message.includes("aborted"))
        return "CLIENT_CANCELLED";
    if (mapped.status === 429)
        return "RATE_LIMITED";
    if (mapped.status === 408 || mapped.status === 504 || message.includes("timed out"))
        return "TIMEOUT";
    if (mapped.status === 401)
        return "AUTH_FAILED";
    if (mapped.status === 403) {
        if (message.includes("policy") || message.includes("not allowed") || message.includes("disabled"))
            return "POLICY_DENIED";
        return "AUTH_FAILED";
    }
    if (mapped.status === 404)
        return "NOT_FOUND";
    if (mapped.status === 400 && message.includes("schema validation"))
        return "SCHEMA_VALIDATION_FAILED";
    if (mapped.status === 400)
        return "BAD_REQUEST";
    if (mapped.status >= 500)
        return "UPSTREAM_5XX";
    if (mapped.status >= 400)
        return "UPSTREAM_4XX";
    return "INTERNAL_ERROR";
}
export function mapErrorClassToResultStatus(errorClass) {
    if (errorClass === "POLICY_DENIED")
        return "denied";
    if (errorClass === "TIMEOUT")
        return "timeout";
    if (errorClass === "CLIENT_CANCELLED")
        return "cancelled";
    return "error";
}
export class ObservabilityStore {
    startedAtMs = Date.now();
    httpRequestsTotal = new Map();
    httpRequestDuration = new Map();
    mcpRequestsTotal = new Map();
    mcpErrorsTotal = new Map();
    mcpDeniedTotal = new Map();
    toolCallTotals = new Map();
    mcpRequestDuration = new Map();
    sessionDuration = makeHistogram(SESSION_DURATION_BUCKETS_MS);
    recentToolCalls = [];
    sessionsOpenedTotal = 0;
    sessionsClosedTotal = 0;
    recordHttpRequest(input) {
        const method = input.method.toUpperCase();
        const path = input.path || "/";
        const status = String(input.status);
        incrementCounter(this.httpRequestsTotal, keyOf(method, path, status));
        const histogramKey = keyOf(method, path);
        const histogram = this.httpRequestDuration.get(histogramKey) ?? makeHistogram(HTTP_LATENCY_BUCKETS_MS);
        observeHistogram(histogram, input.durationMs);
        this.httpRequestDuration.set(histogramKey, histogram);
    }
    recordSessionOpened() {
        this.sessionsOpenedTotal += 1;
    }
    recordSessionClosed(durationMs) {
        this.sessionsClosedTotal += 1;
        observeHistogram(this.sessionDuration, durationMs);
    }
    recordToolCall(input) {
        const method = input.mcpMethod || "unknown";
        const toolName = input.toolName || "unknown";
        const resultStatus = input.resultStatus || "error";
        const durationMs = Number.isFinite(input.durationMs) ? Math.max(0, input.durationMs) : 0;
        incrementCounter(this.mcpRequestsTotal, keyOf(method, toolName, resultStatus));
        incrementCounter(this.toolCallTotals, toolName);
        const durationKey = keyOf(method, toolName);
        const histogram = this.mcpRequestDuration.get(durationKey) ?? makeHistogram(MCP_LATENCY_BUCKETS_MS);
        observeHistogram(histogram, durationMs);
        this.mcpRequestDuration.set(durationKey, histogram);
        if (input.errorClass) {
            incrementCounter(this.mcpErrorsTotal, keyOf(toolName, input.errorClass));
        }
        if (resultStatus === "denied") {
            const policyRuleId = input.policyRuleId || "unspecified";
            incrementCounter(this.mcpDeniedTotal, keyOf(toolName, policyRuleId));
        }
        this.recentToolCalls.push({
            ts: new Date().toISOString(),
            mcpMethod: method,
            toolName,
            resultStatus,
            durationMs,
            errorClass: input.errorClass ?? null,
            policyRuleId: input.policyRuleId ?? null,
            sessionId: truncatedSessionId(input.sessionId) ?? null,
            clientId: input.clientId ?? null,
            requestId: input.requestId ?? null,
            traceId: input.traceId ?? null,
            userId: input.userId ?? null,
            agentName: input.agentName ?? null,
            toolArgsShape: input.toolArgsShape ?? null,
        });
        if (this.recentToolCalls.length > RECENT_TOOL_CALL_LIMIT) {
            this.recentToolCalls.splice(0, this.recentToolCalls.length - RECENT_TOOL_CALL_LIMIT);
        }
    }
    buildStatusSnapshot(input) {
        const topTools = [...this.toolCallTotals.entries()]
            .sort((lhs, rhs) => rhs[1] - lhs[1])
            .slice(0, 10)
            .map(([toolName, count]) => ({ toolName, count }));
        const topErrors = [...this.mcpErrorsTotal.entries()]
            .map(([key, count]) => {
            const [toolName, errorClass] = splitKey(key);
            return { toolName, errorClass, count };
        })
            .sort((lhs, rhs) => rhs.count - lhs.count)
            .slice(0, 10);
        return {
            ok: Boolean(input.readiness.ok),
            now: new Date().toISOString(),
            uptimeMs: Date.now() - this.startedAtMs,
            activeSessions: input.activeSessions,
            sessionsOpenedTotal: this.sessionsOpenedTotal,
            sessionsClosedTotal: this.sessionsClosedTotal,
            readiness: input.readiness,
            sessions: input.sessions,
            topTools,
            topErrors,
            recentToolCalls: this.recentToolCalls.slice(-25),
        };
    }
    renderPrometheus(activeSessions) {
        const lines = [];
        const uptimeSeconds = toSeconds(Date.now() - this.startedAtMs);
        lines.push("# HELP mcp_uptime_seconds MCP server process uptime in seconds.");
        lines.push("# TYPE mcp_uptime_seconds gauge");
        lines.push(`mcp_uptime_seconds ${uptimeSeconds.toFixed(3)}`);
        lines.push("# HELP mcp_active_sessions Active MCP sessions.");
        lines.push("# TYPE mcp_active_sessions gauge");
        lines.push(`mcp_active_sessions ${activeSessions}`);
        lines.push("# HELP mcp_sessions_opened_total Total MCP sessions opened.");
        lines.push("# TYPE mcp_sessions_opened_total counter");
        lines.push(`mcp_sessions_opened_total ${this.sessionsOpenedTotal}`);
        lines.push("# HELP mcp_sessions_closed_total Total MCP sessions closed.");
        lines.push("# TYPE mcp_sessions_closed_total counter");
        lines.push(`mcp_sessions_closed_total ${this.sessionsClosedTotal}`);
        lines.push("# HELP mcp_http_requests_total Total HTTP requests handled by MCP server.");
        lines.push("# TYPE mcp_http_requests_total counter");
        for (const [key, count] of this.httpRequestsTotal.entries()) {
            const [method, path, status] = splitKey(key);
            lines.push(`mcp_http_requests_total{method="${label(method)}",path="${label(path)}",status="${label(status)}"} ${count}`);
        }
        lines.push("# HELP mcp_http_request_duration_seconds HTTP request duration in seconds.");
        lines.push("# TYPE mcp_http_request_duration_seconds histogram");
        for (const [key, histogram] of this.httpRequestDuration.entries()) {
            const [method, path] = splitKey(key);
            let cumulative = 0;
            for (let idx = 0; idx < histogram.bucketsMs.length; idx += 1) {
                cumulative += histogram.bucketCounts[idx];
                lines.push(`mcp_http_request_duration_seconds_bucket{method="${label(method)}",path="${label(path)}",le="${toSeconds(histogram.bucketsMs[idx]).toFixed(3)}"} ${cumulative}`);
            }
            lines.push(`mcp_http_request_duration_seconds_bucket{method="${label(method)}",path="${label(path)}",le="+Inf"} ${histogram.count}`);
            lines.push(`mcp_http_request_duration_seconds_sum{method="${label(method)}",path="${label(path)}"} ${toSeconds(histogram.sumMs).toFixed(6)}`);
            lines.push(`mcp_http_request_duration_seconds_count{method="${label(method)}",path="${label(path)}"} ${histogram.count}`);
        }
        lines.push("# HELP mcp_requests_total Total MCP protocol requests by method/tool/status.");
        lines.push("# TYPE mcp_requests_total counter");
        for (const [key, count] of this.mcpRequestsTotal.entries()) {
            const [method, tool, status] = splitKey(key);
            lines.push(`mcp_requests_total{method="${label(method)}",tool="${label(tool)}",status="${label(status)}"} ${count}`);
        }
        lines.push("# HELP mcp_request_duration_seconds MCP request duration in seconds.");
        lines.push("# TYPE mcp_request_duration_seconds histogram");
        for (const [key, histogram] of this.mcpRequestDuration.entries()) {
            const [method, tool] = splitKey(key);
            let cumulative = 0;
            for (let idx = 0; idx < histogram.bucketsMs.length; idx += 1) {
                cumulative += histogram.bucketCounts[idx];
                lines.push(`mcp_request_duration_seconds_bucket{method="${label(method)}",tool="${label(tool)}",le="${toSeconds(histogram.bucketsMs[idx]).toFixed(3)}"} ${cumulative}`);
            }
            lines.push(`mcp_request_duration_seconds_bucket{method="${label(method)}",tool="${label(tool)}",le="+Inf"} ${histogram.count}`);
            lines.push(`mcp_request_duration_seconds_sum{method="${label(method)}",tool="${label(tool)}"} ${toSeconds(histogram.sumMs).toFixed(6)}`);
            lines.push(`mcp_request_duration_seconds_count{method="${label(method)}",tool="${label(tool)}"} ${histogram.count}`);
        }
        lines.push("# HELP mcp_errors_total Total MCP tool call errors by normalized error class.");
        lines.push("# TYPE mcp_errors_total counter");
        for (const [key, count] of this.mcpErrorsTotal.entries()) {
            const [tool, errorClass] = splitKey(key);
            lines.push(`mcp_errors_total{tool="${label(tool)}",error_class="${label(errorClass)}"} ${count}`);
        }
        lines.push("# HELP mcp_denied_total Total MCP tool call denials by tool and policy rule.");
        lines.push("# TYPE mcp_denied_total counter");
        for (const [key, count] of this.mcpDeniedTotal.entries()) {
            const [tool, policyRule] = splitKey(key);
            lines.push(`mcp_denied_total{tool="${label(tool)}",policy_rule="${label(policyRule)}"} ${count}`);
        }
        lines.push("# HELP mcp_session_duration_seconds MCP session duration in seconds.");
        lines.push("# TYPE mcp_session_duration_seconds histogram");
        let cumulative = 0;
        for (let idx = 0; idx < this.sessionDuration.bucketsMs.length; idx += 1) {
            cumulative += this.sessionDuration.bucketCounts[idx];
            lines.push(`mcp_session_duration_seconds_bucket{le="${toSeconds(this.sessionDuration.bucketsMs[idx]).toFixed(3)}"} ${cumulative}`);
        }
        lines.push(`mcp_session_duration_seconds_bucket{le="+Inf"} ${this.sessionDuration.count}`);
        lines.push(`mcp_session_duration_seconds_sum ${toSeconds(this.sessionDuration.sumMs).toFixed(6)}`);
        lines.push(`mcp_session_duration_seconds_count ${this.sessionDuration.count}`);
        return `${lines.join("\n")}\n`;
    }
}
