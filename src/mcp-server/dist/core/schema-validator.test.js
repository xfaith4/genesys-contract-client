import test from "node:test";
import assert from "node:assert/strict";
import { OperationBodyValidator } from "./schema-validator.js";
function makeOperation(operationId, schema) {
    return {
        catalogKey: operationId,
        operationId,
        method: "POST",
        path: "/test",
        tags: ["Tests"],
        parameters: [
            {
                name: "body",
                in: "body",
                required: true,
                schema,
            },
        ],
        pagingType: "UNKNOWN",
    };
}
test("schema validator enforces oneOf semantics", () => {
    const validator = new OperationBodyValidator({}, true);
    const op = makeOperation("oneOfCase", {
        oneOf: [
            {
                type: "object",
                properties: {
                    mode: { const: "id" },
                    id: { type: "string" },
                },
                required: ["mode", "id"],
                additionalProperties: false,
            },
            {
                type: "object",
                properties: {
                    mode: { const: "name" },
                    name: { type: "string" },
                },
                required: ["mode", "name"],
                additionalProperties: false,
            },
        ],
    });
    assert.equal(validator.validate(op, { mode: "id", id: "abc" }).length, 0);
    assert.ok(validator.validate(op, { mode: "id", name: "abc" }).length > 0);
});
test("schema validator enforces anyOf semantics", () => {
    const validator = new OperationBodyValidator({}, true);
    const op = makeOperation("anyOfCase", {
        anyOf: [
            {
                type: "object",
                properties: { queueId: { type: "string" } },
                required: ["queueId"],
                additionalProperties: false,
            },
            {
                type: "object",
                properties: { divisionId: { type: "string" } },
                required: ["divisionId"],
                additionalProperties: false,
            },
        ],
    });
    assert.equal(validator.validate(op, { queueId: "q-1" }).length, 0);
    assert.equal(validator.validate(op, { divisionId: "d-1" }).length, 0);
    assert.ok(validator.validate(op, { foo: "bar" }).length > 0);
});
test("schema validator preserves allOf merge behavior", () => {
    const validator = new OperationBodyValidator({}, true);
    const op = makeOperation("allOfCase", {
        allOf: [
            {
                type: "object",
                properties: { interval: { type: "string" } },
                required: ["interval"],
            },
            {
                type: "object",
                properties: {
                    paging: {
                        type: "object",
                        properties: {
                            pageSize: { type: "integer" },
                        },
                        required: ["pageSize"],
                    },
                },
                required: ["paging"],
            },
        ],
    });
    assert.equal(validator.validate(op, {
        interval: "2026-02-01T00:00:00.000Z/2026-02-01T01:00:00.000Z",
        paging: { pageSize: 100 },
    }).length, 0);
});
test("schema validator rejects unknown properties in strict mode", () => {
    const validator = new OperationBodyValidator({}, true);
    const op = makeOperation("unknownFieldCase", {
        type: "object",
        properties: {
            interval: { type: "string" },
        },
        required: ["interval"],
    });
    assert.equal(validator.validate(op, { interval: "x" }).length, 0);
    assert.ok(validator.validate(op, { interval: "x", unexpected: true }).length > 0);
});
