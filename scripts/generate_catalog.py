#!/usr/bin/env python3
"""
Generate operations.json and pagination-map.json from a Swagger 2.0 document.

Usage:
  python scripts/generate_catalog.py --swagger specs/swagger.json --out generated
"""
import argparse, json, os, re
from datetime import datetime

def load_json(path):
    with open(path,'r',encoding='utf-8') as f:
        return json.load(f)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--swagger", required=True)
    ap.add_argument("--out", required=True)
    args=ap.parse_args()

    sw = load_json(args.swagger)
    defs = sw.get("definitions", {})
    paths = sw.get("paths", {})

    def resolve_ref(schema):
        if not schema or "$ref" not in schema: return schema
        m=re.match(r"#/definitions/(.+)", schema["$ref"])
        if not m: return schema
        return defs.get(m.group(1), {})

    def schema_top_props(schema):
        schema = resolve_ref(schema)
        return list((schema or {}).get("properties", {}).keys())

    def infer_items_path(schema):
        schema = resolve_ref(schema)
        props = (schema or {}).get("properties", {})
        if "entities" in props and props["entities"].get("type")=="array": return "$.entities"
        if "results" in props and props["results"].get("type")=="array": return "$.results"
        for k,v in props.items():
            if v.get("type")=="array": return f"$.{k}"
        return None

    def classify_paging(props):
        s=set(props or [])
        if "nextUri" in s: return "NEXT_URI"
        if "nextPage" in s: return "NEXT_PAGE"
        if "cursor" in s: return "CURSOR"
        if "after" in s: return "AFTER"
        if {"pageNumber","pageSize"}.issubset(s) and (("pageCount" in s) or ("total" in s) or ("totalCount" in s)):
            return "PAGE_NUMBER"
        if "totalHits" in s: return "TOTALHITS"
        if "startIndex" in s and "pageSize" in s: return "START_INDEX"
        return "UNKNOWN"

    def merge_params(path_item, op_item):
        return (path_item.get("parameters", []) or []) + (op_item.get("parameters", []) or [])

    operations={}
    paging={}
    for path, path_item in paths.items():
        for method, op_item in path_item.items():
            if method.lower() not in {"get","post","put","delete","patch","head","options"}:
                continue
            op_id = op_item.get("operationId") or f"{method.lower()}_{path}"
            params=[]
            for p in merge_params(path_item, op_item):
                params.append({
                    "name": p.get("name"),
                    "in": p.get("in"),
                    "required": bool(p.get("required", False)),
                    "type": p.get("type") or (p.get("schema", {}) or {}).get("type"),
                    "schema": p.get("schema"),
                    "$ref": p.get("$ref"),
                })

            resp = op_item.get("responses", {}) or {}
            schema=None
            for code in ["200","201","202","204","default"]:
                if code in resp and isinstance(resp[code], dict) and "schema" in resp[code]:
                    schema=resp[code]["schema"]; break

            top_props = schema_top_props(schema) if schema else []
            items_path = infer_items_path(schema) if schema else None
            paging_type = classify_paging(top_props) if schema else "UNKNOWN"

            operations[op_id]={
                "operationId": op_id,
                "method": method.upper(),
                "path": path,
                "tags": op_item.get("tags", []) or [],
                "summary": op_item.get("summary"),
                "description": op_item.get("description"),
                "parameters": params,
                "responseTopLevelProperties": top_props,
                "responseItemsPath": items_path,
                "pagingType": paging_type,
            }
            paging[op_id]={
                "type": paging_type,
                "itemsPath": items_path,
                "responseProps": top_props,
            }

    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out,"operations.json"),"w",encoding="utf-8") as f:
        json.dump(operations,f,indent=2)
    with open(os.path.join(args.out,"pagination-map.json"),"w",encoding="utf-8") as f:
        json.dump(paging,f,indent=2)
    with open(os.path.join(args.out,"generated-at.txt"),"w",encoding="utf-8") as f:
        f.write(datetime.utcnow().isoformat()+"Z\n")

if __name__ == "__main__":
    main()
