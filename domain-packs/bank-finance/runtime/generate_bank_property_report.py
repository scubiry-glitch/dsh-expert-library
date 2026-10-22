#!/usr/bin/env python3
"""Generate a Word report from the supplied bank template and live CLI evidence.

The original DOCX is edited in place at the OOXML text nodes, preserving its
paragraphs, tables, styles, headers and page layout. No template example value
is permitted to survive in a generated report.
"""

import argparse
import hashlib
import json
import re
import statistics
import subprocess
import sys
from datetime import date, datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from zipfile import ZipFile

from lxml import etree

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "assets" / "bank-property-value-template.docx"
TEMPLATE_SHA256 = "8893e2803cb8c84643c629d88613f9744e97563302a61603796f93a5fb496983"
NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}


def json_values(raw):
    decoder = json.JSONDecoder()
    values = []
    cursor = 0
    while cursor < len(raw):
        next_object = raw.find("{", cursor)
        if next_object < 0:
            break
        try:
            value, end = decoder.raw_decode(raw, next_object)
        except json.JSONDecodeError:
            cursor = next_object + 1
            continue
        values.append(value)
        cursor = end
    return values


def cli(command, timeout=45):
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
    values = json_values(result.stdout)
    if result.returncode or not values:
        raise RuntimeError(f"命令未返回有效 JSON：{command[0]} {command[1]}（exit={result.returncode}）")
    return values


def summary_objects(text):
    decoder = json.JSONDecoder()
    for match in re.finditer(r'\{\s*"摘要信息"\s*:', text):
        try:
            item, _ = decoder.raw_decode(text, match.start())
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict) and isinstance(item.get("摘要信息"), dict):
            yield item["摘要信息"]


def community_evidence(beike, city, name):
    response = cli([beike, "buy", "resblock", "-c", city, "-q", name, "--json"])[0]
    if response.get("ok") is not True:
        raise RuntimeError("贝壳小区查询失败")
    text = response.get("data", "")
    if f'"检索条件": "小区 = {name}"' not in text or '"match_type": "EXACT"' not in text:
        raise RuntimeError("贝壳未精确命中指定小区")
    candidates = [item for item in summary_objects(text) if item.get("小区名称") == name]
    if len(candidates) != 1:
        raise RuntimeError("贝壳未返回唯一的指定小区")
    return candidates[0]


def listing_evidence(beike, city, name, area):
    responses = cli([beike, "buy", "search", "-c", city, "-q", f"{name} {area:g}平方米 二手房", "--json"])
    comparables = []
    for response in responses:
        if response.get("ok") is not True:
            continue
        text = response.get("data", "")
        if f'"检索条件": "小区 = {name}"' not in text or '"match_type": "EXACT"' not in text:
            continue
        for info in summary_objects(text):
            if name not in info.get("小区信息", "") or info.get("房源售卖状态") != "在售":
                continue
            price = re.search(r"单价约\s*([\d,]+)\s*元/平米", info.get("价格信息", ""))
            size = re.search(r"建筑面积\s*(\d+(?:\.\d+)?)\s*㎡", info.get("户型信息", ""))
            if not price or not size:
                continue
            sample_area = float(size.group(1))
            if not 0.8 * area <= sample_area <= 1.2 * area:
                continue
            comparables.append({"id": info.get("房源ID"), "area_sqm": sample_area,
                                "asking_unit_yuan_sqm": int(price.group(1).replace(",", ""))})
    return list({item["id"]: item for item in comparables if item["id"]}.values())


def timeseries(zyt, city, name):
    base = [zyt, "--json", "指标时序", "--城市", city, "--指标", "SH_PRICE", "--期数", "12"]
    community = cli(base + ["--粒度", "小区", "--小区", name])[0]
    city_data = cli(base)[0]
    return community, city_data


UPPER_DIGITS = "零壹贰叁肆伍陆柒捌玖"
UPPER_UNITS = "仟佰拾"


def upper_money(integer_yuan):
    if integer_yuan == 0:
        return "零元整"
    groups = []
    number = integer_yuan
    while number:
        group = number % 10000
        number //= 10000
        if group:
            parts = []
            zero = False
            for position, digit in enumerate(f"{group:04d}"):
                if digit == "0":
                    zero = bool(parts)
                else:
                    if zero:
                        parts.append("零")
                    parts.append(UPPER_DIGITS[int(digit)] + (UPPER_UNITS[position] if position < 3 else ""))
                    zero = False
            groups.append("".join(parts))
        else:
            groups.append("")
    result = ""
    for index in range(len(groups) - 1, -1, -1):
        group = groups[index]
        if not group:
            if result and index > 0 and not result.endswith("零"):
                result += "零"
            continue
        if result and (integer_yuan // (10000 ** index)) % 10000 < 1000 and not result.endswith("零"):
            result += "零"
        result += group + ("万" if index == 1 else "亿" if index == 2 else "" if index == 0 else f"万亿^{index}")
    return result.rstrip("零") + "元整"


def text_nodes(element):
    return element.xpath(".//w:t", namespaces=NS)


def set_node(element, index, value):
    nodes = text_nodes(element)
    if index >= len(nodes):
        raise RuntimeError("模板文字节点发生变化")
    nodes[index].text = str(value)


def set_cell(table, row, column, value):
    cell = table.xpath("./w:tr", namespaces=NS)[row].xpath("./w:tc", namespaces=NS)[column]
    nodes = text_nodes(cell)
    if not nodes:
        raise RuntimeError("模板表格结构发生变化")
    nodes[0].text = str(value)
    for node in nodes[1:]:
        node.text = ""


def render_xml(name, city, area, bank, branch, company, community, comps, zyt_community, zyt_city):
    if hashlib.sha256(TEMPLATE.read_bytes()).hexdigest() != TEMPLATE_SHA256:
        raise RuntimeError("Word 模板哈希不匹配")
    with ZipFile(TEMPLATE) as archive:
        root = etree.fromstring(archive.read("word/document.xml"))
    body = root.find("w:body", NS)
    elements = list(body)
    tables = root.xpath("//w:body/w:tbl", namespaces=NS)
    if len(tables) != 2 or len(tables[0].xpath("./w:tr", namespaces=NS)) != 6 or len(tables[1].xpath("./w:tr", namespaces=NS)) != 20:
        raise RuntimeError("Word 模板行数发生变化")
    today = date.today()
    unit = total = None
    if len(comps) >= 3:
        unit = int(Decimal(statistics.median(c["asking_unit_yuan_sqm"] for c in comps)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
        total = (Decimal(unit) * Decimal(str(area))).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    value_unit = f"{unit:.2f}" if unit is not None else "待核"
    value_total = f"{total:.2f}" if total is not None else "待核"
    value_upper = upper_money(int(total)) if total is not None else "待核"
    set_node(elements[2], 0, bank)
    set_node(elements[2], 2, branch)
    if not bank and not branch:
        set_node(elements[2], 4, "")
    set_node(elements[3], 6, name)
    set_node(elements[3], 10, f"{area:.2f}")
    set_node(elements[3], 21, today.year)
    set_node(elements[3], 25, f"{today.month:02d}")
    set_node(elements[3], 29, f"{today.day:02d}")
    set_node(elements[4], 2, value_unit)
    set_node(elements[4], 7, value_total)
    set_node(elements[4], 11, value_upper)
    set_node(elements[13], 0, company)
    set_node(elements[13], 1, "")
    set_node(elements[14], 2, today.year)
    set_node(elements[14], 6, f"{today.month:02d}")
    set_node(elements[14], 10, f"{today.day:02d}")

    first, second = tables
    for row, column, value in [(0, 1, name), (1, 1, "-"), (2, 1, "-"), (2, 3, "-"),
                               (3, 1, f"{area:.2f}㎡"), (3, 3, "-"), (4, 2, value_unit), (5, 2, value_total)]:
        set_cell(first, row, column, value)
    set_cell(second, 0, 1, name)
    zone = re.search(r"位于([^，]+)", community.get("小区信息", ""))
    set_cell(second, 1, 1, f"{city}{zone.group(1)}（详细地址待核）" if zone else "待核")
    set_cell(second, 2, 1, community.get("小区信息") or "-")
    set_cell(second, 3, 1, community.get("区位交通") or "-")
    for row in (4, 5, 6, 8, 9, 10, 12, 13, 14):
        set_cell(second, row, 1, "-")
    set_cell(second, 7, 1, community.get("小区环境") or "-")
    set_cell(second, 11, 1, community.get("区位交通") or "-")
    set_cell(second, 15, 1, "住宅（建筑类型待核）")
    year = re.search(r"(\d{4}(?:-\d{4})?)年建成", community.get("小区信息", ""))
    set_cell(second, 16, 1, year.group(1) if year else "-")
    ratio = re.search(r"容积率\s*([\d.]+)", community.get("小区信息", ""))
    set_cell(second, 17, 1, ratio.group(1) if ratio else "-")
    note_cell = second.xpath("./w:tr", namespaces=NS)[18].xpath("./w:tc", namespaces=NS)[1]
    note = "⑦本报告单价取同小区、面积偏差不超过20%的在售房源挂牌单价中位数；挂牌价并非成交价，未查获该小区成交序列，故本结果仅作内部初步参考，不得作为正式抵押估价。" if unit is not None else "⑦同小区有效挂牌样本不足3套，单价与总价待核，不得作为正式抵押估价。"
    latest = (zyt_community.get("series") or zyt_city.get("series") or [])
    level = "小区" if zyt_community.get("series") else "城市"
    note += f"政研通 SH_PRICE 为{level}成交均价时序，最新数据期 {latest[-1].get('period')}；{'城市数据未用于本小区估值。' if level == '城市' else '未替代个案勘查。'}" if latest else "政研通 SH_PRICE 无可用时序。"
    text_nodes(note_cell)[-1].text = (text_nodes(note_cell)[-1].text or "") + note
    xml = etree.tostring(root, encoding="UTF-8", xml_declaration=True, standalone=True)
    if "北京友谱" in xml.decode() or "碧兴园" in xml.decode() and name != "碧兴园":
        raise RuntimeError("生成结果残留模板示例值")
    return xml, unit, total


def main():
    parser = argparse.ArgumentParser(description="按银行 Word 模板生成房产价值咨询报告")
    parser.add_argument("--city", required=True)
    parser.add_argument("--community", required=True)
    parser.add_argument("--area", type=float, required=True, help="建筑面积，平方米")
    parser.add_argument("--bank", default="")
    parser.add_argument("--branch", default="")
    parser.add_argument("--company", default="")
    parser.add_argument("--output", required=True)
    parser.add_argument("--beike-cli", default="beike")
    parser.add_argument("--zyt-cli", default="zyt")
    args = parser.parse_args()
    if not 5 <= args.area <= 1000 or not args.city.strip() or not args.community.strip():
        parser.error("城市、小区和5至1000平方米的面积必填")
    for value in (args.city, args.community, args.bank, args.branch, args.company):
        if len(value) > 120 or any(ord(character) < 32 for character in value):
            parser.error("文字参数含非法字符或过长")
    community = community_evidence(args.beike_cli, args.city, args.community)
    comps = listing_evidence(args.beike_cli, args.city, args.community, args.area)
    zyt_community, zyt_city = timeseries(args.zyt_cli, args.city, args.community)
    xml, unit, total = render_xml(args.community, args.city, args.area, args.bank, args.branch,
                                  args.company, community, comps, zyt_community, zyt_city)
    target = Path(args.output).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(TEMPLATE) as source, ZipFile(target, "w") as output:
        for entry in source.infolist():
            output.writestr(entry, xml if entry.filename == "word/document.xml" else source.read(entry.filename))
    evidence = {"generated_at": datetime.now(timezone.utc).isoformat(), "city": args.city,
                "community": args.community, "area_sqm": args.area,
                "beike_resblock": community, "beike_asking_comparables": comps,
                "zyt_community_SH_PRICE": zyt_community, "zyt_city_SH_PRICE": zyt_city,
                "valuation_method": "matched asking-price median; preliminary reference only" if unit is not None else "unavailable",
                "unit_yuan_sqm": unit, "total_yuan": str(total) if total is not None else None}
    evidence_path = target.with_suffix(".evidence.json")
    evidence_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"file": str(target), "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                      "evidence": str(evidence_path), "status": "preliminary_reference" if unit is not None else "value_pending",
                      "unit_yuan_sqm": unit, "total_yuan": str(total) if total is not None else None}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.TimeoutExpired) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
