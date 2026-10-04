#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""localdb provider runner — read-only SQLite access for dsh-expert-library.

Contract (see src/v2/providers/localdb.ts):
  argv: [ '<json>' ]  one argument, a JSON object:
    { "db": "<absolute path>", "mode": "schema"|"query",
      "sql"?: "<single SELECT>", "table"?: "<name>", "limit"?: <int> }
  stdout: platform envelope JSON
    success: { ok: true, provider: {id,version}, provenance: {source, caliber,
               fetched_at, row_count, truncated}, warnings: [], data: {...},
               truncated: bool }
    failure: { ok: false, error: {code, message, retry, correction}, warnings: [] }

Safety rules enforced here (fail closed):
- the database is opened with a `file:...?mode=ro` URI — SQLite itself refuses
  any write, so no SQL-level guard can be bypassed;
- query mode accepts exactly ONE statement, which must start with SELECT or
  WITH (CTE). No pragma/attach/vacuum, no trailing semicolons, no multiple
  statements;
- row output is bounded (default 100, max 1000) and `truncated` is reported
  so the normalizer can warn instead of silently dropping data;
- all errors are structured envelopes on stdout with exit code 0 or 2 — the
  normalizer never has to guess.
"""

import json
import os
import sqlite3
import sys
import time

VERSION = "1.0.0"
PROVIDER_ID = "localdb"
DEFAULT_LIMIT = 100
MAX_LIMIT = 1000
MAX_DB_BYTES = 8 * 1024 * 1024 * 1024  # 8 GiB sanity bound


def emit(payload, exit_code=0):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.exit(exit_code)


def fail(code, message, correction, exit_code=0):
    emit({
        "ok": False,
        "provider": {"id": PROVIDER_ID, "version": VERSION},
        "warnings": [],
        "truncated": False,
        "error": {"code": code, "message": message, "retry": "never", "correction": correction},
    }, exit_code)


def connect_readonly(path):
    if not os.path.isabs(path):
        fail("DB_PATH_NOT_ABSOLUTE", "db 路径必须是绝对路径", "input.db 必须是绝对路径（由 host 层解析，模型不得自行传相对路径）")
    if not os.path.isfile(path):
        fail("DB_NOT_FOUND", f"数据库文件不存在: {path}", "确认数据库已注册且路径正确（fail-closed：不存在的库不会注册）")
    if os.path.getsize(path) > MAX_DB_BYTES:
        fail("DB_TOO_LARGE", "数据库文件超过 8GiB 上限", "超大库不接入 localdb provider")
    uri = "file:" + path.replace("?", "%3f").replace("#", "%23") + "?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=10)
        conn.execute("SELECT 1")
        return conn
    except sqlite3.Error as exc:
        fail("DB_OPEN_FAILED", f"只读打开失败: {exc}", "确认文件是 SQLite 数据库且进程有读权限")


def validate_select(sql):
    if not isinstance(sql, str) or not sql.strip():
        fail("SQL_REQUIRED", "query 模式必须提供 sql", "input.sql 必须是一条 SELECT/WITH 查询")
    stripped = sql.strip()
    if ";" in stripped.rstrip(";"):
        fail("SQL_MULTIPLE_STATEMENTS", "禁止多条语句", "一次只执行一条查询；去掉多余分号或拆分调用")
    lowered = stripped.lower()
    if not (lowered.startswith("select") or lowered.startswith("with")):
        fail("SQL_READ_ONLY", "只允许 SELECT/WITH 查询", "localdb provider 是只读数据通道；修改请走库外流程")
    return stripped


def fetch_schema(conn, table):
    tables = []
    for row in conn.execute(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ):
        tables.append({"name": row[0], "type": row[1]})
    if table is not None:
        matched = [t for t in tables if t["name"] == table]
        if not matched:
            fail("TABLE_NOT_FOUND", f"表不存在: {table}", "先调用 schema 模式（不带 table）列出全部表名")
        columns = [
            {"name": c[1], "type": c[2], "notnull": bool(c[3]), "pk": bool(c[5])}
            for c in conn.execute(f'PRAGMA table_info("{table.replace(chr(34), "")}")')
        ]
        try:
            count = conn.execute(f'SELECT COUNT(*) FROM "{table.replace(chr(34), "")}"').fetchone()[0]
        except sqlite3.Error:
            count = None
        return {"table": table, "columns": columns, "row_count": count, "tables": None}
    overview = []
    for t in tables:
        try:
            count = conn.execute(f'SELECT COUNT(*) FROM "{t["name"].replace(chr(34), "")}"').fetchone()[0]
        except sqlite3.Error:
            count = None
        overview.append({"name": t["name"], "type": t["type"], "row_count": count})
    return {"table": None, "columns": None, "row_count": None, "tables": overview}


def main():
    if len(sys.argv) != 2:
        fail("USAGE_ERROR", "runner 需要且只需要一个 JSON 参数", "由 localdb provider invoker 调用，勿手工执行")
    try:
        request = json.loads(sys.argv[1])
    except json.JSONDecodeError as exc:
        fail("USAGE_ERROR", f"参数不是合法 JSON: {exc}", "由 localdb provider invoker 调用，勿手工执行")
    if not isinstance(request, dict):
        fail("USAGE_ERROR", "参数必须是 JSON 对象", "由 localdb provider invoker 调用")
    path = request.get("db")
    mode = request.get("mode")
    if mode not in ("schema", "query"):
        fail("MODE_INVALID", f"未知 mode: {mode}", "mode 必须是 schema 或 query")
    if not isinstance(path, str):
        fail("USAGE_ERROR", "db 必须是字符串路径", "由 host 层从已注册数据库解析")

    conn = connect_readonly(path)
    try:
        started = time.time()
        if mode == "schema":
            data = fetch_schema(conn, request.get("table"))
            row_count = len(data["tables"]) if data["tables"] is not None else len(data["columns"] or [])
            truncated = False
        else:
            sql = validate_select(request.get("sql"))
            try:
                limit = int(request.get("limit") or DEFAULT_LIMIT)
            except (TypeError, ValueError):
                limit = DEFAULT_LIMIT
            limit = max(1, min(limit, MAX_LIMIT))
            try:
                cursor = conn.execute(sql)
                columns = [d[0] for d in cursor.description] if cursor.description else []
                rows = []
                truncated = False
                for row in cursor:
                    if len(rows) >= limit:
                        truncated = cursor.fetchone() is not None or truncated
                        # fetchone above already consumed one row; a None means exactly limit rows
                        if not truncated:
                            pass
                        break
                    rows.append(list(row))
                data = {"columns": columns, "rows": rows}
                row_count = len(rows)
            except sqlite3.Error as exc:
                fail("SQL_EXEC_FAILED", f"SQL 执行失败: {exc}", "检查表名/字段名（可先用 schema 模式探查）与 SQL 语法")
        elapsed_ms = int((time.time() - started) * 1000)
        emit({
            "ok": True,
            "capability": request.get("capability"),
            "provider": {"id": PROVIDER_ID, "version": VERSION},
            "provenance": {
                "source": path,
                "caliber": request.get("caliber") or "本地 SQLite 只读查询（以库内字段口径为准）",
                "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "row_count": row_count,
                "truncated": truncated,
                "elapsed_ms": elapsed_ms,
            },
            "warnings": [],
            "data": data,
            "truncated": truncated,
        })
    finally:
        conn.close()


if __name__ == "__main__":
    main()
