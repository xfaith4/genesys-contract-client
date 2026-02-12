import { createMcpApp } from "./mcp/server.js";
import { resolveRepoRoot } from "./core/config.js";
import { GenesysCoreService } from "./core/service.js";
import { logInfo } from "./core/utils.js";
import { registerLegacyHttpRoutes } from "./http/legacy.js";
const repoRoot = resolveRepoRoot(import.meta.url);
const core = new GenesysCoreService(repoRoot);
const app = createMcpApp(core);
if (core.config.legacyHttpApi) {
    registerLegacyHttpRoutes(app, core);
    logInfo("legacy.http.enabled", {
        describe: "/describe",
        call: "/call",
        callAll: "/callAll",
        toolsInvoke: "/tools/invoke",
    });
}
const server = app.listen(core.config.port, core.config.host, () => {
    core.logStartup();
    logInfo("mcp.server.ready", {
        mcpPath: core.config.mcpPath,
        healthPath: core.config.healthPath,
        legacyHttpApi: core.config.legacyHttpApi,
    });
});
function shutdown(signal) {
    logInfo("server.shutdown", { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
export { app, core, server };
