import Ajv from "ajv";
import addFormats from "ajv-formats";
import { httpError, isPlainObject } from "./utils.js";
export class OperationBodyValidator {
    ajv;
    definitions;
    strictUnknownProperties;
    cache = new Map();
    constructor(definitions, strictUnknownProperties) {
        this.definitions = definitions;
        this.strictUnknownProperties = strictUnknownProperties;
        this.ajv = new Ajv({
            allErrors: true,
            strict: false,
            allowUnionTypes: true,
            validateSchema: false,
        });
        addFormats(this.ajv);
    }
    validate(operation, body) {
        const validator = this.getOrCompileValidator(operation);
        if (!validator)
            return [];
        const ok = validator(body);
        if (ok)
            return [];
        return (validator.errors ?? []).map((err) => {
            const path = err.instancePath && err.instancePath.length > 0 ? `$body${err.instancePath}` : "$body";
            return `${path}: ${err.message ?? "invalid value"}`;
        });
    }
    getOrCompileValidator(operation) {
        const cacheKey = operation.catalogKey || operation.operationId;
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey) ?? null;
        }
        const bodyParam = operation.parameters.find((p) => p.in === "body");
        if (!bodyParam?.schema) {
            this.cache.set(cacheKey, null);
            return null;
        }
        const jsonSchema = this.convertSchema(bodyParam.schema, [], false);
        if (!isPlainObject(jsonSchema)) {
            this.cache.set(cacheKey, null);
            return null;
        }
        const validator = this.ajv.compile(jsonSchema);
        this.cache.set(cacheKey, validator);
        return validator;
    }
    convertSchema(schema, stack, parentInCombiner) {
        if (!isPlainObject(schema))
            return schema;
        if (typeof schema.$ref === "string") {
            const ref = String(schema.$ref);
            if (!ref.startsWith("#/definitions/")) {
                throw httpError(400, `Unsupported body schema ref '${ref}'.`);
            }
            const defName = ref.slice("#/definitions/".length);
            if (stack.includes(defName)) {
                return {};
            }
            const resolved = this.definitions[defName];
            if (!resolved) {
                throw httpError(400, `Schema definition '${defName}' not found.`);
            }
            return this.convertSchema(resolved, [...stack, defName], parentInCombiner);
        }
        const out = {};
        for (const [key, value] of Object.entries(schema)) {
            if (key === "$ref")
                continue;
            if (key === "x-nullable")
                continue;
            if (key === "nullable")
                continue;
            if (key === "properties" && isPlainObject(value)) {
                const props = {};
                for (const [propName, propSchema] of Object.entries(value)) {
                    props[propName] = this.convertSchema(propSchema, stack, false);
                }
                out.properties = props;
                continue;
            }
            if (key === "items") {
                out.items = this.convertSchema(value, stack, false);
                continue;
            }
            if ((key === "allOf" || key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
                out[key] = value.map((entry) => this.convertSchema(entry, stack, true));
                continue;
            }
            if (key === "not") {
                out.not = this.convertSchema(value, stack, false);
                continue;
            }
            if (key === "additionalProperties" && isPlainObject(value)) {
                out.additionalProperties = this.convertSchema(value, stack, false);
                continue;
            }
            if (isPlainObject(value)) {
                out[key] = this.convertSchema(value, stack, false);
            }
            else if (Array.isArray(value)) {
                out[key] = value.map((entry) => (isPlainObject(entry) ? this.convertSchema(entry, stack, false) : entry));
            }
            else {
                out[key] = value;
            }
        }
        const isNullable = schema["x-nullable"] === true || schema.nullable === true;
        const hasCombiner = Array.isArray(out.allOf) || Array.isArray(out.anyOf) || Array.isArray(out.oneOf);
        const isObjectSchema = out.type === "object" || (isPlainObject(out.properties) && Object.keys(out.properties).length > 0) || Array.isArray(out.required);
        if (this.strictUnknownProperties && isObjectSchema && out.additionalProperties === undefined && !hasCombiner && !parentInCombiner) {
            out.additionalProperties = false;
        }
        if (isNullable) {
            return {
                anyOf: [out, { type: "null" }],
            };
        }
        return out;
    }
}
