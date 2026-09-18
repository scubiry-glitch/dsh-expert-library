# -*- coding: utf-8 -*-
"""
build_records.py — 从《信用卡方法论提取-专家分析报告.md》（完整版）提取全部 81 条记录，
生成 methodology-records.json 与 verification-items.json。可重跑。
"""
import json, re, os, datetime

BASE = os.path.dirname(os.path.abspath(__file__))
MD = os.path.join(BASE, "信用卡方法论提取-专家分析报告.md")
BRIEF_OLD = os.path.join(BASE, "信用卡方法论提取-精简版.html")  # 仅用于复用旧版一句话要点
OUT_RECORDS = os.path.join(BASE, "methodology-records.json")
OUT_VERIFY = os.path.join(BASE, "verification-items.json")

# ---------------- 材料简称映射（source_short 用） ----------------
# A 系列：阿蒙森洞察，期数从出处中的文件名解析（2022/2021 年第 N 期 → 22-N期 / 21-N期）
MAT_PERIOD = {  # B 系列基准时点（完整版 1.3）
    "B01": "25", "B02": "24", "B03": "23", "B04": "25",
    "B05": "18", "B06": "21", "B07": "24", "B08": "18",
}

def mat_short(raw_id):
    """B-05 → B05；B-01 → B01；A01 不变"""
    m = raw_id.strip()
    m = re.sub(r"^B-0(\d)$", r"B0\1", m)
    return m

def clean_quote(q):
    """剥离质检修正注（保留原文照录本体）"""
    segs = []
    for seg in q.split("<br>"):
        s = seg.strip()
        if "【质检修正" in s:
            s = re.sub(r"【质检修正[^】]*】", "", s).strip()
            if re.match(r"^(原引文|原标注)", s):
                continue
        elif re.match(r"^(原引文|原标注)", s):
            continue
        if s:
            segs.append(s)
    return "\n".join(segs)

def parse_page( 出处):
    """从出处串取第一个页码/幻灯片/行引用"""
    m = re.search(r"PDF页码\s*(\d+\s*[–\-—]\s*\d+|\d+)", 出处)
    if m:
        return "P" + m.group(1).replace(" ", "")
    m = re.search(r"第\s*(\d+\s*[–\-—]\s*\d+|\d+)\s*页", 出处)
    if m:
        return "P" + m.group(1).replace(" ", "")
    m = re.search(r"幻灯片\s*(\d+)", 出处)
    if m:
        return "幻" + m.group(1)
    m = re.search(r"工作表\s*\S*?\s*行(\d+)", 出处) or re.search(r"行(\d+)", 出处)
    if m:
        return "行" + m.group(1)
    return ""

def make_source_short(出处):
    """统一格式：材料ID·期数/年份 P页码或幻灯片N（≤16 字符）"""
    m = re.search(r"(A\d{2}|B-\d{2}|B\d{2})", 出处)
    if not m:
        return ""
    mid = mat_short(m.group(1))
    # 期数：优先从出处中的文件名取（A 系列带 期）
    per = None
    if mid.startswith("A"):
        pm = re.search(r"(\d{4})年第(\d+)期", 出处)
        if pm:
            per = pm.group(1)[2:] + "-" + pm.group(2) + "期"
    else:
        per = MAT_PERIOD.get(mid, "")
    pg = parse_page(出处)
    unit = "幻" if pg.startswith("幻") else ("行" if pg.startswith("行") else "P")
    sep = "·" + per if per else ""
    # 页码过长时压缩区间为起始页
    pgv = pg[1:]
    if len(f"{mid}{sep} {unit}{pgv}") > 15 and "–" in pgv:
        pgv = pgv.split("–")[0] + "+"
    s = f"{mid}{sep} {unit}{pgv}"
    return s

# ---------------- 解析完整版 md ----------------
def strip_md(t):
    t = re.sub(r"\*\*(.+?)\*\*", r"\1", t)
    t = t.replace("`", "")
    t = t.split("\n---")[0].rstrip(" -\n")
    return t.strip()

def parse_records(md):
    lines = md.split("\n")
    records = []
    layer = None
    cur = None
    for ln in lines:
        if ln.startswith("## 三、"):
            layer = 1; continue
        if ln.startswith("## 四、"):
            layer = 2; continue
        if ln.startswith("## 五、"):
            layer = 3; continue
        if ln.startswith("## 六、"):
            layer = None; continue
        m = re.match(r"^### ((?:A\d{2}|B-\d{2})-\d{2})｜(.+)$", ln)
        if m and layer:
            cur = {"id": m.group(1), "name": m.group(2).strip(), "layer": layer, "fields": {}, "_bullet_key": None}
            records.append(cur)
            continue
        if cur is not None and (ln.startswith("### ") or ln.startswith("## ")):
            cur = None  # 记录区结束（小节标题等）
            continue
        if cur is not None:
            fm = re.match(r"^\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*$", ln)
            if fm and fm.group(1) != "字段" and not fm.group(1).startswith("-"):
                key = fm.group(1).strip()
                if key not in cur["fields"]:
                    cur["fields"][key] = fm.group(2).strip()
                continue
            # 第二/三层项目符号格式：- **字段**：内容（可跨多行直到下一个 - **）
            bm = re.match(r"^- \*\*(.+?)\*\*[：:]\s*(.*)$", ln)
            if bm:
                cur["_bullet_key"] = bm.group(1).strip()
                if cur["_bullet_key"] not in cur["fields"]:
                    cur["fields"][cur["_bullet_key"]] = bm.group(2).strip()
                else:
                    cur["fields"][cur["_bullet_key"]] += "\n" + bm.group(2).strip()
            elif re.match(r"^\s{2,}\d+\.\s", ln):
                if cur.get("_bullet_key"):
                    cur["fields"][cur["_bullet_key"]] += "\n" + ln.strip()
            elif ln.strip() and cur["_bullet_key"]:
                cur["fields"][cur["_bullet_key"]] += "\n" + ln.strip()
    return records

def parse_chains(md):
    """6.1 六条工作链：解析每条链引用的组件统一编号"""
    sec = md.split("### 6.1")[1].split("### 6.2")[0]
    chains = {}
    for row in sec.split("\n"):
        m = re.match(r"^\|\s*(\d)\s*\|", row)
        if m:
            ids = re.findall(r"(?:A\d{2}|B-\d{2})-\d{2}", row)
            chains[int(m.group(1))] = sorted(set(ids))
    return chains

def parse_comprehensive(md):
    """6.4 综合可迁移性排序：高/中/低三组统一编号清单"""
    sec = section_between(md, "### 6.4", ["### 6.5"])
    groups, cur = {}, None
    for ln in sec.split("\n"):
        if ln.startswith("**高"):
            cur = "高"; groups[cur] = []
        elif ln.startswith("**中"):
            cur = "中"; groups[cur] = []
        elif ln.startswith("**低"):
            cur = "低"; groups[cur] = []
        elif cur:
            m = re.match(r"^\|\s*`((?:A\d{2}|B-\d{2})-\d{2})`\s*\|", ln)
            if m:
                groups[cur].append(m.group(1))
    return groups

def section_between(md, start, ends):
    sec = md.split(start)[1]
    cut = len(sec)
    for e in ends:
        p = sec.find(e)
        if p != -1:
            cut = min(cut, p)
    return sec[:cut]

def parse_verify(md):
    """6.6 待验证项 V-01~V-12"""
    sec = section_between(md, "### 6.6", ["\n## ", "\n### ", "\n---\n"])
    items = []
    for ln in sec.split("\n"):
        m = re.match(r"^\|\s*(V-\d{2})\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$", ln)
        if m:
            items.append({"id": m.group(1), "desc": strip_md(m.group(2)),
                          "layer": m.group(3).strip(), "reason": strip_md(m.group(4))})
    return items

# 本地核实结论（合并 verification-results.md，2026-09-16 会话内逐项复核：text/ 逐页检索 + 原件 OOXML 解包 + PyMuPDF 比对）
VERIFY_STATUS = {
    "V-01": ("部分闭环", "抽核 3 处正文引用绝对值均与 PDF 文本层一致（47/35/18 出自正文）；仅图上未印数值标签的数据点本地读不出，核查范围内报告未引用此类数值"),
    "V-02": ("已闭环", "确证 A10 行237「假数据，排序性未变」、A09 行166「示意数据…绝对值已模糊处理」原文自注，报告不引绝对值的处理与原文一致"),
    "V-03": ("已闭环", "确证原文未给阈值/AUC/漂移监控（「低于20分」仅为举例）；补齐需外部算法方"),
    "V-04": ("已闭环", "确证 A13/A16 只给聚类结果，k-means 等算法名与阈值 0 命中；补齐需外部"),
    "V-05": ("已闭环", "确证原文只讲迭代动因，双轨/切换/可比 0 命中；「双轨过渡」系报告引申要求，做法需外部补齐"),
    "V-06": ("已闭环", "确证原文按单动作量化杠杆，叠加/蚕食/互斥 0 命中；多动作叠加测算须自行补校正"),
    "V-07": ("需外部材料", "2022 年第 6 期 text/ 与 sources/ 均缺失（17 份齐全清单核对），本地不可弥补"),
    "V-08": ("已闭环", "确证 B05 全篇「城商行」0 命中，测算分母均为全国/上市行口径；城商行对标须另找区域性银行样本"),
    "V-09": ("已闭环", "改判：B04 计划表年度为「2026 年度」——xlsx 元数据 created 2026-03-15 自证（creator 蔡诚），文内「苏超服务」等佐证；此前「推断 2025 年度」作废"),
    "V-10": ("已闭环", "确证 B06 全篇仅汽车分期早偿数据（装修/车位 0 命中）；外推须另行取证"),
    "V-11": ("已闭环", "幻41/49/54 配对经原件 slideN.xml shape 坐标（EMU）逐项核实，报告语义分组全部无误，「需回原件核对」标注可解除"),
    "V-12": ("部分闭环", "幻53 时点改标「约2017年」（图内嵌工作簿数据系列名自证，属强指向非文内明示；同节幻50–51 为截至2016年底口径）；「实动卡均交易」精确口径仍需外部（银联定义）"),
}

# ---------------- 旧精简版的一句话要点复用 ----------------
def parse_old_brief():
    sums = {}
    if not os.path.exists(BRIEF_OLD):
        return sums
    html = open(BRIEF_OLD, encoding="utf-8").read()
    for tr in re.findall(r"<tr><td class=\"c-id\">(.*?)</td><td class=\"c-name\">(.*?)</td><td class=\"c-sum\">(.*?)</td>.*?</tr>", html):
        sums[tr[0]] = tr[2].strip()
    return sums

# ---------------- 主流程 ----------------
def main():
    md = open(MD, encoding="utf-8").read()
    records = parse_records(md)
    chains = parse_chains(md)
    comp = parse_comprehensive(md)
    vitems = parse_verify(md)
    old_sums = parse_old_brief()

    comp_map = {}
    for g, ids in comp.items():
        for i in ids:
            comp_map[i] = g

    layers_meta = {1: "材料自带的分析方法论", 2: "业务打法方法论", 3: "外部视角评价框架"}
    layers_out = {1: [], 2: [], 3: []}
    warn = []
    for r in records:
        f = r["fields"]
        raw_src = f.get("出处", "")
        quote = clean_quote(re.sub(r"【质检修正[^】]*】", "", f.get("原文关键句", "")).strip())
        extra_q = f.get("补充直引（照录）") or f.get("补充直引")
        if extra_q:
            quote += "\n" + clean_quote(re.sub(r"【质检修正[^】]*】", "", extra_q).strip())
        transfer_raw = strip_md(f.get("可迁移性初判", ""))
        if transfer_raw.startswith("高"):
            tr = "高"
        elif transfer_raw.startswith("中"):
            tr = "中"
        elif transfer_raw.startswith("低"):
            tr = "低"
        else:
            tr = "中"
            warn.append(r["id"] + " 可迁移性初判无法解析")
        ss = make_source_short(raw_src)
        if len(ss) > 16:
            warn.append(f"{r['id']} source_short 超长({len(ss)}): {ss}")
        chain_refs = ["链%d" % n for n in sorted(chains) if r["id"] in chains[n]]
        rec = {
            "id": r["id"],
            "name": r["name"],
            "summary": old_sums.get(r["id"], strip_md(f.get("方法拆解", ""))[:30]),
            "source_short": ss,
            "source_full": raw_src,
            "quote": quote,
            "breakdown": strip_md(f.get("方法拆解", "")).replace("<br>", "\n"),
            "boundary": strip_md(f.get("适用条件与边界", "")).replace("<br>", "\n"),
            "transfer": tr,
            "transfer_detail": transfer_raw.replace("\n", " "),
            "chain_refs": chain_refs,
        }
        # V-09 修正注记：B04 计划年度改判（verification-results.md 为准，不改完整版原文）
        if "B04" in raw_src:
            rec["correction"] = "V-09 改判：B04 计划表年度实为 2026 年度（xlsx 元数据 created 2026-03-15 自证，creator 蔡诚），此前「推断 2025 年度」作废（修正以 verification-results.md 为准）"
        layers_out[r["layer"]].append(rec)

    counts = {k: len(v) for k, v in layers_out.items()}
    total = sum(counts.values())
    tstat = {"高": 0, "中": 0, "低": 0, "—": 0}
    for lay in layers_out.values():
        for r in lay:
            tstat[comp_map.get(r["id"], "—")] += 1

    data = {
        "meta": {
            "title": "信用卡方法论提取 · 结构化记录",
            "generated_at": datetime.date.today().isoformat(),
            "generated_by": "build_records.py（数据源：信用卡方法论提取-专家分析报告.md 完整版）",
            "total_records": total,
            "layer_counts": {str(k): v for k, v in counts.items()},
            "layer_names": {str(k): v for k, v in layers_meta.items()},
            "transfer_comprehensive": tstat,
            "comprehensive_standard": "综合可迁移性分级以完整版 6.4 为准（高 17 / 中 22 / 低 9，其余 33 条未入排序）",
            "comprehensive": {g: ids for g, ids in comp.items()},
            "chains": {"链%d" % n: ids for n, ids in sorted(chains.items())},
            "verify_total": len(vitems),
            "notes": "81 条含条目级可迁移性初判（transfer_detail）；引文为完整版原文照录（质检修正注已剥离，修正记录见完整版 2.3）。",
        },
        "layers": [
            {"layer": k, "name": layers_meta[k], "records": layers_out[k]} for k in (1, 2, 3)
        ],
    }
    with open(OUT_RECORDS, "w", encoding="utf-8") as fp:
        json.dump(data, fp, ensure_ascii=False, indent=1)

    vout = {
        "meta": {
            "generated_at": datetime.date.today().isoformat(),
            "generated_by": "build_records.py（数据源：完整版 6.6 跨层待验证项汇总）",
            "status_legend": {"已闭环": "已在本机材料内逐项复核确认（text/ 逐页检索 + 原件 OOXML 解包 + PyMuPDF 比对）", "部分闭环": "关键结论已本地核实，但残留口径/数值需外部材料补齐", "需外部材料": "材料外数据/文件，本地无从核实"},
            "verified_against": "verification-results.md（另一核实代理产出，2026-09-16）",
        },
        "items": [
            {"id": v["id"], "desc": v["desc"], "layer": v["layer"], "reason": v["reason"],
             "status": VERIFY_STATUS[v["id"]][0], "local_check": VERIFY_STATUS[v["id"]][1]}
            for v in vitems
        ],
    }
    with open(OUT_VERIFY, "w", encoding="utf-8") as fp:
        json.dump(vout, fp, ensure_ascii=False, indent=1)

    print(f"记录数：{total}（L1 {counts[1]} / L2 {counts[2]} / L3 {counts[3]}）")
    print(f"综合迁移性：{tstat}")
    print(f"链组件：{ {('链%d'%n): len(v) for n, v in chains.items()} }")
    print(f"待验证项：{len(vitems)}")
    if warn:
        print("警告："); [print(" -", w) for w in warn]

if __name__ == "__main__":
    main()
