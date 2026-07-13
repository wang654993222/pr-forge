#!/usr/bin/env python3
"""Relay Review MCP Server — JSON-RPC over stdin/stdout"""
import json, sys, os, traceback
sys.path.insert(0, os.path.dirname(__file__))
from config import load_config
from tools.context import register_context_tools
from tools.status import register_status_tools
from tools.post import register_post_tools

VERSION = "1.0.0"

def main():
    config = load_config()
    tools = _build_tool_registry()
    _log(f"Relay Review MCP v{VERSION} starting", "INFO")

    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        try: request = json.loads(line)
        except json.JSONDecodeError as e:
            _send_error(None, -32700, f"Parse error: {e}"); continue
        method = request.get("method", ""); rid = request.get("id")
        if method == "initialize":
            _send_response(rid, {"protocolVersion": "2024-11-05",
                "serverInfo": {"name": "relay-review-mcp", "version": VERSION},
                "capabilities": {"tools": {}}})
        elif method == "notifications/initialized": pass
        elif method == "tools/list":
            _send_response(rid, {"tools": [v["schema"] for v in tools.values()]})
        elif method == "tools/call":
            name = request.get("params", {}).get("name", "")
            args = request.get("params", {}).get("arguments", {})
            _handle_tool_call(rid, name, args, tools, config)
        else: _send_error(rid, -32601, f"Method not found: {method}")
    _log("Relay Review MCP exiting", "INFO")

def _build_tool_registry():
    r = {}
    register_context_tools(r)
    register_status_tools(r)
    register_post_tools(r)
    return r

def _handle_tool_call(rid, name, args, registry, config):
    if name not in registry:
        _send_error(rid, -32602, f"Unknown tool: {name}"); return
    try:
        handler = registry[name]["handler"]
        result = handler(args, config)
        text = json.dumps(result, ensure_ascii=False, indent=2)
        _send_response(rid, {"content": [{"type": "text", "text": text}]})
    except Exception as e:
        tb = traceback.format_exc()
        # Token mask: 避免 token 泄露到日志
        if "token" in config.get("github", {}):
            tb = tb.replace(config["github"]["token"], "***")
        _log(f"Tool '{name}' failed: {tb}", "ERROR")
        _send_response(rid, {"content": [{"type": "text", "text": json.dumps(
            {"ok": False, "error": {"code": "INTERNAL_ERROR", "message": str(e)}},
            ensure_ascii=False)}], "isError": True})

def _send_response(rid, result):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": rid, "result": result}, ensure_ascii=False) + "\n")
    sys.stdout.flush()

def _send_error(rid, code, message):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}, ensure_ascii=False) + "\n")
    sys.stdout.flush()

def _log(msg, level="INFO"):
    sys.stderr.write(f"[{level}] relay-review-mcp: {msg}\n"); sys.stderr.flush()

if __name__ == "__main__": main()
