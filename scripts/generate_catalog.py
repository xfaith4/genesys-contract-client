#!/usr/bin/env python3
"""
Generate operations.json and pagination-map.json from a Swagger 2.0 document.

Usage:
  python scripts/generate_catalog.py --swagger specs/swagger.json --out generated
  python scripts/generate_catalog.py --swagger specs/swagger.json --out generated --paging-registry registry/paging-registry.yaml
"""

import argparse
import json
import os
import re
from datetime import datetime, timezone


HTTP_METHODS = {"get", "post", "put", "delete", "patch", "head", "options"}


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_paging_registry(path):
    """
    Lightweight parser for registry/paging-registry.yaml.
    Expected shape:
      operationId:
        type: TOTALHITS
        itemsPath: $.conversations
    """
    if not path:
        return {}
    if not os.path.exists(path):
        return {}

    overrides = {}
    current_key = None

    with open(path, "r", encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.split("#", 1)[0].rstrip("\n")
            stripped = line.strip()
            if not stripped or stripped == "---":
                continue

            if not line.startswith(" "):
                if stripped.endswith(":"):
                    current_key = stripped[:-1].strip().strip("'\"")
                    overrides[current_key] = {}
                else:
                    current_key = None
                continue

            if current_key and ":" in stripped:
                field, value = stripped.split(":", 1)
                field = field.strip()
                value = value.strip().strip("'\"")
                if value != "":
                    overrides[current_key][field] = value

    return {k: v for k, v in overrides.items() if v}


def make_catalog(swagger, paging_registry):
    defs = swagger.get("definitions", {})
    paths = swagger.get("paths", {})
    security_defs = swagger.get("securityDefinitions", {})

    def resolve_ref(schema):
        if not schema or "$ref" not in schema:
            return schema
        m = re.match(r"#/definitions/(.+)", schema["$ref"])
        if not m:
            return schema
        return defs.get(m.group(1), {})

    def schema_top_props(schema):
        schema = resolve_ref(schema)
        return list((schema or {}).get("properties", {}).keys())

    def infer_items_path(schema):
        schema = resolve_ref(schema)
        props = (schema or {}).get("properties", {})
        if "entities" in props and props["entities"].get("type") == "array":
            return "$.entities"
        if "results" in props and props["results"].get("type") == "array":
            return "$.results"
        if "conversations" in props and props["conversations"].get("type") == "array":
            return "$.conversations"
        for k, v in props.items():
            if isinstance(v, dict) and v.get("type") == "array":
                return f"$.{k}"
        return None

    def classify_paging(props):
        s = set(props or [])
        if "nextUri" in s:
            return "NEXT_URI"
        if "nextPage" in s:
            return "NEXT_PAGE"
        if "cursor" in s:
            return "CURSOR"
        if "after" in s:
            return "AFTER"
        if {"pageNumber", "pageSize"}.issubset(s) and ("pageCount" in s or "total" in s or "totalCount" in s):
            return "PAGE_NUMBER"
        if "totalHits" in s:
            return "TOTALHITS"
        if "startIndex" in s and "pageSize" in s:
            return "START_INDEX"
        return "UNKNOWN"

    def merge_params(path_item, op_item):
        return (path_item.get("parameters", []) or []) + (op_item.get("parameters", []) or [])

    def extract_required_permissions(security):
        if not isinstance(security, list):
            return None
        required = []
        for requirement in security:
            if not isinstance(requirement, dict):
                continue
            for sec_name, scopes in requirement.items():
                if sec_name in security_defs and isinstance(scopes, list):
                    required.extend([s for s in scopes if isinstance(s, str)])
        if not required:
            return None
        return sorted(set(required))

    operations = {}
    paging = {}
    seen_catalog_keys = set()

    for api_path, path_item in paths.items():
        for method, op_item in path_item.items():
            method_l = method.lower()
            if method_l not in HTTP_METHODS:
                continue

            op_id = op_item.get("operationId") or f"{method_l}_{api_path}"
            catalog_key = op_id
            suffix = 2
            while catalog_key in seen_catalog_keys:
                catalog_key = f"{op_id}__{suffix}"
                suffix += 1
            seen_catalog_keys.add(catalog_key)

            params = []
            for p in merge_params(path_item, op_item):
                params.append(
                    {
                        "name": p.get("name"),
                        "in": p.get("in"),
                        "required": bool(p.get("required", False)),
                        "type": p.get("type") or (p.get("schema", {}) or {}).get("type"),
                        "schema": p.get("schema"),
                        "$ref": p.get("$ref"),
                    }
                )

            responses = op_item.get("responses", {}) or {}
            response_schema = None
            for code in ["200", "201", "202", "203", "204", "default"]:
                candidate = responses.get(code)
                if isinstance(candidate, dict) and "schema" in candidate:
                    response_schema = candidate["schema"]
                    break

            top_props = schema_top_props(response_schema) if response_schema else []
            items_path = infer_items_path(response_schema) if response_schema else None
            paging_type = classify_paging(top_props) if response_schema else "UNKNOWN"

            override = paging_registry.get(catalog_key) or paging_registry.get(op_id)
            if override:
                paging_type = override.get("type", paging_type)
                items_path = override.get("itemsPath", items_path)

            security = op_item.get("security", swagger.get("security"))

            operations[catalog_key] = {
                "catalogKey": catalog_key,
                "operationId": op_id,
                "method": method.upper(),
                "path": api_path,
                "tags": op_item.get("tags", []) or [],
                "summary": op_item.get("summary") or "",
                "description": op_item.get("description") or "",
                "security": security,
                "requiredPermissions": extract_required_permissions(security),
                "parameters": params,
                "responseTopLevelProperties": top_props,
                "responseItemsPath": items_path,
                "pagingType": paging_type,
            }

            paging[catalog_key] = {
                "type": paging_type,
                "itemsPath": items_path,
                "responseProps": top_props,
            }

    return operations, paging


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--swagger", required=True, help="Path to swagger.json")
    parser.add_argument("--out", required=True, help="Output directory")
    parser.add_argument(
        "--paging-registry",
        required=False,
        default=None,
        help="Optional paging-registry.yaml with operation-level overrides",
    )
    args = parser.parse_args()

    swagger = load_json(args.swagger)
    paging_registry = load_paging_registry(args.paging_registry)
    operations, paging = make_catalog(swagger, paging_registry)

    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "operations.json"), "w", encoding="utf-8") as f:
        json.dump(operations, f, indent=2)

    with open(os.path.join(args.out, "pagination-map.json"), "w", encoding="utf-8") as f:
        json.dump(paging, f, indent=2)

    with open(os.path.join(args.out, "generated-at.txt"), "w", encoding="utf-8") as f:
        f.write(datetime.now(timezone.utc).isoformat().replace("+00:00", "Z") + "\n")


if __name__ == "__main__":
    main()
