#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""t6 v2 · 渲染源构建：t5 融合正式稿 md → 审计账本式纸墨 HTML5
单源：expert-teams/智见点评-制度设计/expert-tasks/t5/output/融合稿_收储用途扩围与平台机会_正式稿.md
设计：暖纸 #F1EEE7 + 近白卡 #FDFCF9 + 孔雀青 #10605A + 古金 #9A6B22
      发丝线账册对开（.frame / 账册 rule）、tabular-nums、四级标注色块
纪律：正文数字逐字取自 md（不改写）；【融合说明】如有则删除，不入渲染
"""
import re, html, pathlib, json, sys

HERE = pathlib.Path(__file__).resolve().parent
MD = pathlib.Path("/root/zhijian/dsh-expert-library/work/expert-teams/智见点评-制度设计/"
                  "expert-tasks/t5/output/融合稿_收储用途扩围与平台机会_正式稿.md")
OUT = HERE / "html/收储用途扩围与平台机会_正式稿.html"

# ---------- 1. 读源 + 删【融合说明】段 ----------
raw = MD.read_text(encoding="utf-8")
stripped = re.sub(r"\n#{2,4}\s*【?融合说明】?.*?(?=\n#{2,4}\s|\Z)", "\n", raw, flags=re.S)
had_fusion = stripped != raw
src = stripped

# ---------- 2. 四级标注 ----------
LEVELS = {
    "引用":     ("ref",  "来源明确，以原文口径为准"),
    "测算":     ("calc", "依据在案数据推算"),
    "估算":     ("est",  "量级推断，区间口径"),
    "研判推断": ("jud",  "无直接数据支撑的方向判断"),
    "待补":     ("todo", "需官方文件或授权数据核验"),
}
LEVEL_ORDER = ["引用", "测算", "估算", "研判推断", "待补"]


def mark(m):
    """【引用，案例归纳非统一统计】 → <span class=tag tag-ref>引用<i>案例归纳非统一统计</i></span>"""
    inner = m.group(1).strip()
    parts = re.split(r"[，,；;]", inner, maxsplit=1)
    label = parts[0].strip()
    qual = parts[1].strip() if len(parts) > 1 else ""
    cls = LEVELS.get(label, ("ref", ""))[0]
    q = f"<i>{html.escape(qual)}</i>" if qual else ""
    return f'<span class="tag tag-{cls}">{html.escape(label)}{q}</span>'


def inline(t):
    t = html.escape(t, quote=False)
    t = re.sub(r"【([^】]+)】", mark, t)
    t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
    return t


# ---------- 3. 解析 md ----------
lines = src.split("\n")
title = lines[0].lstrip("# ").strip()
meta_line = ""
legend_line = ""
i = 1
while i < len(lines) and (lines[i].strip() == "" or lines[i].startswith("**")):
    if lines[i].startswith("**智见点评"):
        meta_line = lines[i]
    if lines[i].startswith("**数字四级标注说明**"):
        legend_line = lines[i]
    i += 1

# 表格题注（按表头首列识别；宽表=用途矩阵）
CAPTIONS = {
    "线索": ("Ex.1", "三条线的推进状态：资金端先行、采购制度化最慢", ""),
    "阈值": ("Ex.2", "年度化准公共采购 vs 个案化处置：四项判别阈值", "四项须同时成立，缺一项即判为个案化处置"),
    "用途": ("Ex.3", "用途—现金流矩阵：用途是资本结构的选择变量", "占比口径为案例归纳，非统一统计；分城市数据与绝对量待补", True),
    "维度": ("Ex.4", "房源准入评分卡：四项一票否决", "一票否决优先于总分排序，评分卡用于筛掉不可行项目"),
    "退出路径": ("Ex.5", "退出谱系：三条路径的互斥条件", "三条路径各有成立条件，不能同时承诺"),
    "阶段": ("Ex.6", "全周期模型：五段结构与口径要求", "购置—改造—运营—持有—退出"),
    "序号": ("Ex.7", "观察指标七项", "口径不公开项一律不作推测"),
    "情景": ("Ex.8", "未来12个月三情景", "基准最可能；乐观与风险为条件情景"),
}
WIDE_HEADERS = {"用途"}

body = []          # emitted html blocks
tbl_n = 0
buf_para = []


def flush_para():
    global buf_para
    if buf_para:
        txt = " ".join(buf_para).strip()
        if txt:
            body.append(f'<p>{inline(txt)}</p>')
        buf_para = []


j = i
while j < len(lines):
    ln = lines[j]
    s = ln.strip()

    if s == "" or s == "---":
        flush_para(); j += 1; continue

    # ---- headings ----
    m = re.match(r"^##\s+(?!#)(.*)$", s)
    if m:
        flush_para()
        body.append(("chapter", m.group(1).strip()))
        j += 1; continue
    m = re.match(r"^###\s+(.*)$", s)
    if m:
        flush_para()
        body.append(("section", m.group(1).strip()))
        j += 1; continue

    # ---- tables ----
    if s.startswith("|"):
        flush_para()
        rows = []
        while j < len(lines) and lines[j].strip().startswith("|"):
            cells = [c.strip() for c in lines[j].strip().strip("|").split("|")]
            if not all(re.fullmatch(r":?-{2,}:?", c or "-") for c in cells):
                rows.append(cells)
            j += 1
        if not rows:
            continue
        head, body_rows = rows[0], rows[1:]
        key = head[0]
        info = CAPTIONS.get(key)
        tbl_n += 1
        if info is None:
            info = (f"Ex.{tbl_n}", key, "")
        exno, extitle, exsub = info[0], info[1], info[2]
        wide = len(info) > 3 and info[3]
        # 单元格内容保留标注
        th = "".join(f"<th>{html.escape(c)}</th>" for c in head)
        trs = []
        for r in body_rows:
            tds = []
            for ci, c in enumerate(r):
                lab = head[ci] if ci < len(head) else ""
                tds.append(f'<td data-label="{html.escape(lab)}">{inline(c)}</td>')
            trs.append("<tr>" + "".join(tds) + "</tr>")
        cls = "exhibit wide-exhibit" if wide else "exhibit"
        sub = f'<p class="ex-sub">{html.escape(exsub)}</p>' if exsub else ""
        body.append((
            "exhibit",
            f'<figure class="{cls}">'
            f'<div class="ex-head"><span class="ex-no">{exno}</span>'
            f'<span class="ex-title">{html.escape(extitle)}</span></div>{sub}'
            f'<div class="tblwrap"><table><thead><tr>{th}</tr></thead><tbody>{"".join(trs)}</tbody></table></div>'
            f'</figure>'
        ))
        continue

    # ---- 平台责任边界：两行转对开 ----
    if s.startswith("**可承接：**") or s.startswith("**不可承接：**"):
        flush_para()
        blocks = {}
        while j < len(lines):
            t = lines[j].strip()
            if t.startswith("**可承接：**"):
                blocks["do"] = re.sub(r"^\*\*可承接：\*\*\s*", "", t).rstrip("。")
            elif t.startswith("**不可承接：**"):
                blocks["dont"] = re.sub(r"^\*\*不可承接：\*\*\s*", "", t).rstrip("。")
            elif t == "":
                j += 1
                if len(blocks) == 2:
                    break
                continue
            else:
                break
            j += 1
        def items(txt):
            txt = re.sub(r"【[^】]+】$", "", txt)
            return "".join(f"<li>{inline(x.strip())}</li>" for x in re.split(r"、", txt) if x.strip())
        body.append((
            "frame2",
            '<figure class="exhibit"><div class="ex-head"><span class="ex-no">Ex.9</span>'
            '<span class="ex-title">平台可承接／不可承接责任边界</span></div>'
            '<p class="ex-sub">发丝线账册对开：左为可承接，右为不可承接</p>'
            '<div class="frame">'
            f'<div class="side do"><h4>可承接</h4><ul>{items(blocks.get("do",""))}</ul></div>'
            f'<div class="side dont"><h4>不可承接</h4><ul>{items(blocks.get("dont",""))}</ul></div>'
            '</div></figure>'
        ))
        continue

    buf_para.append(s)
    j += 1

flush_para()

# ---------- 4. 组装 HTML ----------
LEGEND = "".join(
    f'<span class="tag tag-{LEVELS[k][0]}">{k}</span><em>{LEVELS[k][1]}</em>'
    for k in LEVEL_ORDER
)

NUMSTRIP = [
    ("约50%", "", "保租房占收购用途", "中房网 2026-05-20；公开案例归纳，非统一统计"),
    ("551", "套", "上海三试点区累计收房", "应作全国上限锚点，不作起步基数"),
    ("5.336", "亿元", "深圳大学拟购楼作宿舍", "腾讯新闻 2026-09-09；高校自主采购"),
    ("4", "项", "评分卡一票否决", "区位·现金流·合规产权·退出可及性"),
]
numstrip = "".join(
    f'<div class="cell"><div class="big">{v}<span class="u">{u}</span></div>'
    f'<div class="lbl">{l}</div><div class="src">{s}</div></div>'
    for v, u, l, s in NUMSTRIP
)

CN = "零一二三四五六七八九十"
chap_html, sec_no = [], 0
toc = []
for blk in body:
    if isinstance(blk, tuple) and blk[0] == "chapter":
        t = blk[1]
        m = re.match(r"^([一二三四五六七八九十]+)、(.*)$", t)
        if m:
            chap_html.append(f'<section class="chapter"><div class="chapter-head">'
                             f'<h2><span class="chapno">第 {m.group(1)} 章</span>{html.escape(m.group(2))}</h2></div>')
            toc.append(m.group(2))
        else:
            chap_html.append(f'<section class="chapter"><div class="chapter-head">'
                             f'<h2>{html.escape(t)}</h2></div>')
            toc.append(t)
    elif isinstance(blk, tuple) and blk[0] == "section":
        sec_no += 1
        chap_html.append(f'<h3><span class="secno">{sec_no}</span>{html.escape(blk[1])}</h3>')
    elif isinstance(blk, tuple):
        chap_html.append(blk[1])
    else:
        chap_html.append(blk)

doc_body = "".join(chap_html)
# close sections: wrap each chapter
parts = doc_body.split('<section class="chapter">')
rebuilt = parts[0]
for p in parts[1:]:
    rebuilt += '<section class="chapter">' + p + "</section>"
doc_body = rebuilt

DATA_SOURCES = ""
m = re.search(r"\*\*数据来源\*\*：(.*)$", src, re.S)
if m:
    DATA_SOURCES = m.group(1).strip().replace("\n", " ")

HTML_DOC = f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)} · 智见点评 · 制度设计</title>
<style>
/* finesse · register=product · A=warm-paper+peacock-teal+antique-gold · B=serif/sans/mono
 * C=ledger-spread(hairline) · D=none(zero-JS) · E=audit-ledger-paper-ink
 * SOUL=6 SPECTACLE=1 DENSITY=8 */
:root{{
  /* substrate：暖纸底 + 近白卡（审计账本纸墨） */
  --paper:#F1EEE7; --card:#FDFCF9; --card-2:#F7F5EF; --recess:#EAE6DE;
  /* ink（暖调中性，全部 ≥4.5:1 于 paper 与 card） */
  --ink-1:#1A1714; --ink-2:#443E37; --ink-3:#6B6459; --ink-4:#6E675D;
  /* 发丝线 */
  --rule:rgba(26,23,20,.15); --rule-soft:rgba(26,23,20,.08); --rule-strong:rgba(26,23,20,.30);
  /* 主色：孔雀青 */
  --peacock:#10605A; --peacock-d:#0B4A45; --peacock-soft:#E2EDEA; --on-peacock:#F2F7F5;
  /* 强调：古金 */
  --gold:#9A6B22; --gold-ink:#7E5618; --gold-soft:#F0E6D3;
  /* 语义 */
  --warn:#8A3A26; --warn-soft:#F2E2DC;
  --font-serif:"Noto Serif CJK SC","Source Han Serif SC","Songti SC",Georgia,serif;
  --font-sans:"Noto Sans CJK SC","Source Han Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  --font-mono:"Noto Sans Mono CJK SC",ui-monospace,Menlo,Consolas,monospace;
  --shadow:0 1px 2px rgba(26,23,20,.05);
  --r:6px; --r-sm:4px;
  --nav-h:50px;
}}
*{{box-sizing:border-box}}
html,body{{overflow-x:clip}}
html{{-webkit-text-size-adjust:100%}}
body{{
  margin:0;background:var(--paper);color:var(--ink-1);
  font-family:var(--font-serif);font-size:15px;line-height:1.8;
  font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;
}}
.sheet{{max-width:1120px;margin:0 auto;padding:0 26px 80px}}

/* ---------- masthead ---------- */
.masthead{{position:sticky;top:0;z-index:50;background:rgba(241,238,231,.95);
  border-bottom:1px solid var(--rule);backdrop-filter:blur(6px)}}
.masthead .inner{{max-width:1120px;margin:0 auto;padding:0 26px;min-height:var(--nav-h);
  display:flex;align-items:center;gap:16px;font-family:var(--font-sans);font-size:11.5px;
  color:var(--ink-3);white-space:nowrap;overflow-x:auto}}
.masthead .mk{{color:var(--peacock);font-weight:700;letter-spacing:.06em;flex:0 0 auto}}
.masthead a{{color:var(--ink-3);text-decoration:none;flex:0 0 auto}}
.masthead a:hover{{color:var(--peacock)}}

/* ---------- cover ---------- */
.cover{{padding:30px 0 8px}}
.cover-band{{background:var(--peacock);color:var(--on-peacock);padding:26px 30px 28px;border-radius:var(--r)}}
.cover-band .brandline{{font-family:var(--font-sans);font-size:11px;letter-spacing:.18em;
  text-transform:uppercase;color:#A9CFC8;font-weight:700}}
.cover-band h1{{font-family:var(--font-serif);font-size:clamp(25px,3.6vw,38px);line-height:1.28;
  letter-spacing:-.015em;font-weight:600;margin:14px 0 0;overflow-wrap:anywhere;min-width:0}}
.cover-band .sub{{margin:14px 0 0;font-size:14px;line-height:1.7;color:#C9E1DB;max-width:46em}}
.cover-band .metaline{{margin:16px 0 0;padding-top:14px;border-top:1px solid rgba(255,255,255,.22);
  font-family:var(--font-sans);font-size:11.5px;color:#C9E1DB;display:flex;flex-wrap:wrap;gap:6px 18px}}
.kicker-quote{{margin:18px 0 0;border-left:3px solid var(--gold);background:var(--card);
  padding:14px 20px;border-radius:0 var(--r-sm) var(--r-sm) 0}}
.kicker-quote p{{margin:0;font-size:16px;line-height:1.72;color:var(--ink-1)}}
.kicker-quote em{{font-style:normal;color:var(--gold-ink);font-weight:700}}

/* ---------- numstrip（发丝线分格 + tabular-nums） ---------- */
.numstrip{{display:flex;gap:0;margin:18px 0 0;background:var(--card);
  border:1px solid var(--rule);border-radius:var(--r);overflow:hidden;box-shadow:var(--shadow)}}
.numstrip .cell{{flex:1 1 0;min-width:0;padding:14px 16px;border-left:1px solid var(--rule)}}
.numstrip .cell:first-child{{border-left:0}}
.numstrip .big{{font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-size:20px;
  font-weight:700;color:var(--peacock);letter-spacing:-.01em;line-height:1.15}}
.numstrip .big .u{{font-size:12px;font-weight:500;color:var(--ink-2);margin-left:2px}}
.numstrip .lbl{{font-family:var(--font-sans);font-size:12px;color:var(--ink-2);margin-top:6px;font-weight:700}}
.numstrip .src{{font-family:var(--font-sans);font-size:10.5px;color:var(--ink-4);margin-top:4px;line-height:1.5}}

/* ---------- legend（四级标注） ---------- */
.legend{{margin:18px 0 0;background:var(--card);border:1px solid var(--rule);border-radius:var(--r);
  padding:14px 18px}}
.legend .lt{{font-family:var(--font-sans);font-size:12px;font-weight:700;color:var(--ink-1);margin-bottom:9px}}
.legend .row{{display:flex;flex-wrap:wrap;gap:8px 20px}}
.legend .row span{{display:inline-flex;align-items:center;gap:6px;font-family:var(--font-sans);
  font-size:11.5px;color:var(--ink-3)}}

/* ---------- annotation tags（色块，全文一致） ---------- */
.tag{{display:inline-block;font-family:var(--font-sans);font-size:.80em;font-weight:700;line-height:1.5;
  padding:0 5px;border-radius:3px;white-space:nowrap;vertical-align:1px;font-style:normal}}
.tag i{{font-style:normal;font-weight:500;opacity:.86;margin-left:3px}}
.tag-ref{{color:var(--peacock);background:var(--peacock-soft)}}
.tag-calc{{color:var(--gold-ink);background:var(--gold-soft)}}
.tag-est{{color:var(--gold-ink);background:var(--gold-soft);border:1px dashed var(--gold)}}
.tag-jud{{color:var(--ink-2);background:var(--recess)}}
.tag-todo{{color:var(--warn);background:var(--warn-soft)}}

/* ---------- chapter / section ---------- */
.chapter{{margin:46px 0 0;scroll-margin-top:60px}}
.chapter-head{{display:flex;align-items:baseline;gap:12px;border-bottom:3px double var(--gold);
  padding-bottom:9px;margin:0 0 20px;break-after:avoid}}
.chapter-head h2{{font-family:var(--font-serif);font-weight:600;font-size:21px;line-height:1.34;
  letter-spacing:-.01em;margin:0;overflow-wrap:anywhere;min-width:0}}
.chapno{{font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;color:var(--gold-ink);
  margin-right:10px;vertical-align:2px;white-space:nowrap}}
h3{{font-family:var(--font-serif);font-size:16.5px;font-weight:600;line-height:1.45;margin:26px 0 10px;
  color:var(--ink-1);break-after:avoid}}
.secno{{font-family:var(--font-mono);font-size:11px;color:var(--gold-ink);margin-right:9px;
  vertical-align:2px}}
p{{margin:0 0 12px}}
strong{{font-weight:700;color:var(--ink-1)}}
em{{font-style:normal}}

/* ---------- exhibit（图号卡片，发丝线） ---------- */
.exhibit{{background:var(--card);border:1px solid var(--rule);border-radius:var(--r);
  box-shadow:var(--shadow);padding:16px 18px 14px;margin:20px 0;break-inside:avoid}}
.ex-head{{display:flex;align-items:baseline;gap:10px;margin:0 0 3px}}
.ex-no{{font-family:var(--font-mono);font-size:11px;letter-spacing:.06em;color:var(--gold-ink);
  white-space:nowrap;text-transform:uppercase}}
.ex-title{{font-family:var(--font-serif);font-size:15px;font-weight:600;color:var(--ink-1);line-height:1.45}}
.ex-sub{{font-family:var(--font-sans);font-size:11px;color:var(--ink-3);margin:5px 0 0;line-height:1.6}}

.tblwrap{{margin:12px 0 0;overflow-x:auto;border-top:1px solid var(--rule-soft)}}
table{{border-collapse:collapse;width:100%;font-family:var(--font-sans);font-size:12.5px;
  line-height:1.62;font-variant-numeric:tabular-nums}}
th,td{{padding:8px 10px;text-align:left;vertical-align:top;border-bottom:1px solid var(--rule-soft)}}
th{{background:var(--peacock-soft);color:var(--peacock-d);font-weight:700;font-size:11.5px;
  border-bottom:1px solid var(--rule);white-space:nowrap}}
tbody tr:last-child td{{border-bottom:0}}
td:first-child{{font-weight:700;color:var(--ink-1)}}

/* ---------- 对开 frame（发丝线账册） ---------- */
.frame{{display:flex;gap:0;margin:12px 0 0;border:1px solid var(--rule);border-radius:var(--r-sm);
  overflow:hidden}}
.frame .side{{flex:1 1 0;min-width:0;padding:14px 16px}}
.frame .side + .side{{border-left:1px solid var(--rule)}}
.frame .side.do{{background:var(--peacock-soft)}}
.frame .side.dont{{background:var(--warn-soft)}}
.frame h4{{font-family:var(--font-sans);font-size:12.5px;font-weight:700;margin:0 0 9px}}
.frame .side.do h4{{color:var(--peacock-d)}}
.frame .side.dont h4{{color:var(--warn)}}
.frame ul{{margin:0;padding:0;list-style:none}}
.frame li{{font-family:var(--font-sans);font-size:12.5px;line-height:1.6;padding-left:15px;
  position:relative;margin-bottom:7px;color:var(--ink-2)}}
.frame li::before{{content:"";position:absolute;left:0;top:8px;width:5px;height:5px;border-radius:50%}}
.frame .side.do li::before{{background:var(--peacock)}}
.frame .side.dont li::before{{background:var(--warn)}}
.frame li:last-child{{margin-bottom:0}}

/* ---------- colophon ---------- */
.colophon{{margin:40px 0 0;padding-top:14px;border-top:1px solid var(--rule);
  display:flex;flex-wrap:wrap;gap:6px 22px;font-family:var(--font-sans);font-size:11px;color:var(--ink-3)}}
.colophon b{{color:var(--ink-2);font-weight:700}}
.backcover{{margin:34px 0 0;background:var(--peacock-d);color:var(--on-peacock);border-radius:var(--r);
  padding:28px 30px}}
.backcover .bq{{font-size:19px;line-height:1.6;font-weight:600;margin:0 0 18px;color:var(--on-peacock)}}
.backcover .bq em{{font-style:normal;color:#EFC98A}}
.backcover .meta{{font-family:var(--font-sans);font-size:11.5px;line-height:1.9;color:#BBD5D0}}
.backcover .meta b{{color:#DCEAE7}}
.disclaim{{margin:14px 0 0;padding-top:12px;border-top:1px solid rgba(255,255,255,.18);
  font-family:var(--font-sans);font-size:11px;color:#BBD5D0;line-height:1.7}}

/* ---------- 窄屏降级（320 → 1280 零溢出） ---------- */
@media (max-width:900px){{
  .numstrip{{flex-wrap:wrap}}
  .numstrip .cell{{flex:1 1 50%}}
  .numstrip .cell:nth-child(odd){{border-left:0}}
  .numstrip .cell:nth-child(n+3){{border-top:1px solid var(--rule)}}
  .frame{{flex-direction:column}}
  .frame .side + .side{{border-left:0;border-top:1px solid var(--rule)}}
}}
@media (max-width:760px){{
  .sheet{{padding:0 14px 56px}}
  .masthead .inner{{padding:0 14px}}
  body{{font-size:14.5px}}
  .cover-band{{padding:20px 18px 22px}}
  /* 表 → 卡行：表头隐藏，逐格带字段名（窄屏不横向溢出） */
  .tblwrap{{overflow-x:visible}}
  .tblwrap table,.tblwrap thead,.tblwrap tbody,.tblwrap tr,.tblwrap th,.tblwrap td{{display:block;width:auto}}
  .tblwrap thead{{display:none}}
  .tblwrap tr{{padding:10px 12px;border-bottom:1px solid var(--rule-soft);
    border-top:2px solid var(--peacock);margin-bottom:8px;background:var(--card)}}
  .tblwrap tr:last-child{{border-bottom:0}}
  .tblwrap td{{border:0;padding:2px 0;font-weight:400;color:var(--ink-2)}}
  .tblwrap td:first-child{{font-weight:700;color:var(--ink-1);font-size:13.5px;margin-bottom:3px}}
  .tblwrap td[data-label]::before{{content:attr(data-label);display:block;font-size:10px;
    letter-spacing:.03em;color:var(--ink-4);line-height:1.5}}
  .tblwrap td:first-child::before{{display:none}}
  .frame .side{{padding:12px 13px}}
  .chapter-head h2{{font-size:18px}}
}}
@media (max-width:400px){{
  .numstrip .cell{{flex:1 1 100%;border-left:0}}
  .numstrip .cell:nth-child(n+2){{border-top:1px solid var(--rule)}}
}}

/* ---------- print / PDF（A4，页脚品牌+页码） ---------- */
@media print{{
  body{{background:var(--paper)}}
  .masthead{{display:none}}
  .sheet{{max-width:none;padding:0}}
  .cover{{page:cover}}
  .backcover{{page:back}}
  .chapter{{margin:22px 0 0}}
  /* 表单页/图卡/表行不跨页断裂 */
  .exhibit,.frame,.numstrip,.numstrip .cell,.legend,.kicker-quote,.cover-band,
  .tblwrap tr,.colophon{{break-inside:avoid}}
  .chapter-head,h3,h4,thead{{break-after:avoid}}
  .tblwrap{{overflow:visible}}
  table{{font-size:9pt;table-layout:fixed}}
  th,td{{padding:5px 6px;overflow-wrap:anywhere;word-break:break-word}}
  thead th{{white-space:normal}}
  .ex-no{{font-size:8pt}} .ex-title{{font-size:10.5pt}}
  /* 宽表独占横向页，保持可读且不裁切 */
  .wide-exhibit{{page:landscape;break-before:page;break-inside:avoid}}
  .wide-exhibit table{{font-size:8.2pt}}
  .wide-exhibit th,.wide-exhibit td{{padding:4px 5px}}
}}
@page{{
  size:A4;margin:16mm 14mm 17mm 14mm;
  @bottom-center{{
    content:"98wiki ｜ 智见 / 行业研究报告 · 第 " counter(page) " 页 / 共 " counter(pages) " 页";
    font-family:"Noto Serif CJK SC",serif;font-size:8pt;color:#6B6459;
  }}
}}
@page cover{{@bottom-center{{content:"98wiki ｜ 智见 / 行业研究报告"}}}}
@page back{{@bottom-center{{content:none}}}}
@page landscape{{size:A4 landscape;margin:12mm 14mm 16mm 14mm;
  @bottom-center{{
    content:"98wiki ｜ 智见 / 行业研究报告 · 第 " counter(page) " 页 / 共 " counter(pages) " 页";
    font-family:"Noto Serif CJK SC",serif;font-size:8pt;color:#6B6459;
  }}}}
</style>
</head>
<body>

<nav class="masthead"><div class="inner">
  <span class="mk">98wiki ｜ 智见</span>
  {"".join(f'<a href="#c{n+1}">{html.escape(t)}</a>' for n, t in enumerate(toc))}
  <a href="#src">来源与口径</a>
</div></nav>

<div class="sheet">

<header class="cover">
  <div class="cover-band">
    <div class="brandline">98wiki ｜ 智见点评 · 制度设计</div>
    <h1>{html.escape(title)}</h1>
    <p class="sub">审计账本式纸墨设计 · 全篇数字取自融合正式稿原文，未作改写；四级标注全文一致。</p>
    <div class="metaline"><span>正式稿</span><span>证据窗 2025-09 — 2026-09</span>
      <span>全国（郑州、上海、杭州、武汉、深圳案例对比）</span></div>
  </div>

  <div class="kicker-quote">
    <p>用途扩围扩大的是<em>需求池的口径</em>，没有触动负carry、区位错配、改造合规这三项真实交易成本；退出不通时，收储会从准公共采购退化为<em>准公共持有</em>。</p>
  </div>

  <div class="numstrip">{numstrip}</div>

  <div class="legend">
    <div class="lt">数字四级标注（全文一致，色块角标）</div>
    <div class="row">{LEGEND}</div>
  </div>
</header>

{doc_body}

<section class="chapter" id="src">
  <div class="chapter-head"><h2><span class="chapno">附录</span>数据来源与口径</h2></div>
  <p><strong>数据来源：</strong>{inline(DATA_SOURCES)}</p>
  <p><strong>口径提示：</strong>保租房约50%、人才房与青年公寓约20%、学生宿舍等新用途约5%，均为公开案例归纳，非统一统计口径，只有分子没有分母，不可加总为全国结构、不可用于推算全国规模。深圳大学5.336亿元为披露金额口径，床位与单套折算待补；单路采购意向口径约5.3亿元。单床购置成本约35.6万元、单位面积购置成本约0.24万元／平方米均为依据在案数据<span class="tag tag-calc">测算</span>。上海551套为徐汇、浦东、静安三试点区累计收房口径。中国人民银行保障性住房再贷款支持比例调整的具体比例<span class="tag tag-todo">待补</span>。</p>
  <div class="colophon">
    <span><b>版本</b> 正式稿 · 制度设计</span>
    <span><b>证据窗</b> 2025-09 — 2026-09</span>
    <span><b>区域</b> 全国（五城案例对比）</span>
    <span><b>标注体系</b> 引用 / 测算 / 估算 / 研判推断 / 待补</span>
    <span><b>版式</b> 审计账本式纸墨 · 发丝线账册对开</span>
  </div>
</section>

<div class="backcover">
  <p class="bq">用途扩围改变的是<em>需求池的口径</em>，不改变<em>谁付钱、多久回本</em>。<br>
    平台交付可审计的判据，政府与国企承担资产与预算。</p>
  <div class="meta">
    <div><b>版本</b>　正式稿 · 制度设计 ｜ 证据窗 2025-09 — 2026-09</div>
    <div><b>数据口径</b>　中房网、吴晓波频道／新浪财经、腾讯新闻、中国政府网、深圳市住建局、中国人民银行、新浪财经</div>
    <div><b>标注体系</b>　引用 · 测算 · 估算 · 研判推断 · 待补</div>
  </div>
  <div class="disclaim">行业研究，不构成投资建议；文中测算、估算与研判推断均非官方统计。案例归纳数字不可作为全国总量或官方口径引用。</div>
</div>

</div>
</body>
</html>
"""

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(HTML_DOC, encoding="utf-8")
print(f"wrote {OUT}  ({len(HTML_DOC.encode())}B)")
print(f"fusion-section stripped: {had_fusion}")
print(f"tables rendered: {tbl_n}  sections numbered: {sec_no}")
print(f"marks: " + ", ".join(f"{k}×{raw.count('【'+k+'】')}" for k in LEVEL_ORDER))
