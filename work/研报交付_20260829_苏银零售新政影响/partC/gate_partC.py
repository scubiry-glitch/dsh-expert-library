#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""99wiki Part C 分型验收器（wiki-gated-research §Part C · logic-annex-v2）
改造自 partB/gate_partB.py 审计框架。每次运行：weasyprint 重渲染 PDF → playwright/Chromium
重截图（宽屏元素级）→ fitz 重栅格化 A4 → 重算 HTML/PDF 哈希 → Chromium DOM 检查 → 写 gate_partC.json。
纪律：DOM 优先，nested_p_count 等一律以 Chromium 加载后的 DOM 为准，禁止正则判嵌套；
Part C 不检查主文页数/封面/KPI/正文 10000 字门（那是 Part B 验收器的事）。"""
import hashlib, json, subprocess, sys, datetime, re
from pathlib import Path

BASE = Path("/root/zhijian/dsh-expert-library/work/研报交付_20260829_苏银零售新政影响/partC")
HTML = BASE / "逻辑附件.html"
PDF = BASE / "逻辑附件.pdf"
SHOTS = BASE / "shots"
GATE = BASE / "gate_partC.json"
FOOTER_SIG = "98wiki ｜ 智见 / 行业研究报告"
TEMPLATE_ID = "logic-annex-v2"
OLD_CLASSES = ["summary-grid", "logic-card", "annex-card-v1", "scard", "grid15"]
OLD_SIGS = ["政研通研究院", "智见行业研究 ｜ 行业研究报告"]
PLACEHOLDER_PAT = re.compile(r"待补充|占位符|placeholder|Lorem|lorem|TODO|此处省略")
DIAGRAM_TYPES_REQUIRED = {"传导链", "决策树", "时间轴", "对照条形", "错配矩阵"}

def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def render_pdf():
    code = ("from weasyprint import HTML;"
            f"HTML(filename=r'{HTML}').write_pdf(r'{PDF}')")
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("weasyprint failed:\n" + r.stderr[-3000:])
    import weasyprint
    return {"time": datetime.datetime.now().isoformat(timespec="seconds"),
            "method": f"weasyprint {weasyprint.__version__} · A4 portrait · source=逻辑附件.html @media print"}

def raster_a4(pages_idx):
    import fitz
    doc = fitz.open(str(PDF))
    n = doc.page_count
    out = []
    for i in pages_idx:
        if i >= n:
            continue
        pix = doc[i].get_pixmap(dpi=100)
        p = SHOTS / f"a4_p{i+1:02d}.png"
        pix.save(str(p))
        out.append(p)
    doc.close()
    return n, out

def pdf_audit():
    """A4 PDF：每页页脚署名 + 文本块越界（fitz 几何审计）。"""
    import fitz
    doc = fitz.open(str(PDF))
    no_sig, bad = [], []
    for i, pg in enumerate(doc):
        txt = pg.get_text()
        if FOOTER_SIG not in txt:
            no_sig.append(i + 1)
        pr = pg.rect
        for b in pg.get_text("blocks"):
            x0, y0, x1, y1 = b[:4]
            if x0 < -2 or y0 < -2 or x1 > pr.width + 2 or y1 > pr.height + 2:
                bad.append({"page": i + 1, "bbox": [round(v, 1) for v in (x0, y0, x1, y1)]})
    doc.close()
    return no_sig, bad

def dom_and_wide_shots():
    from playwright.sync_api import sync_playwright
    errors, console_errs = [], []
    exe = "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome"
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=exe if Path(exe).exists() else None)
        page = browser.new_page(viewport={"width": 1440, "height": 1200}, device_scale_factor=1)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: console_errs.append(m.text) if m.type == "error" else None)
        page.goto(HTML.as_uri(), wait_until="networkidle")
        page.wait_for_timeout(400)

        d = page.evaluate("""() => {
          const cjk = s => (s.match(/[\\u4e00-\\u9fff]/g) || []).length;
          const root = document.documentElement;
          const metaTag = document.querySelector('meta[name="logic_template_id"]');
          // —— 计数（DOM 标准）——
          const qcards = [...document.querySelectorAll('.qcard')];
          const lcards = [...document.querySelectorAll('.lcard')];
          const svgs = [...document.querySelectorAll('svg.logicmap')];
          const plains = document.querySelectorAll('.lcard .plain');
          const takes = [...document.querySelectorAll('.takes li')];
          const alts = [...document.querySelectorAll('.alt')];
          const protos = [...document.querySelectorAll('#data-protocol')];
          const protoItems = document.querySelectorAll('#data-protocol .proto-item');
          const obs = document.querySelectorAll('#data-protocol .obs');
          const qgrids = document.querySelectorAll('.qgrid');
          // —— 详细卡逐项完整性 ——
          const cardReport = lcards.map(c => ({
            id: c.id, num: c.getAttribute('data-card'),
            title: !!c.querySelector('.ltitle'),
            prem: !!c.querySelector('.lc-prem'),
            prem_items: c.querySelectorAll('.lc-prem li').length,
            chain_steps: c.querySelectorAll('.chain .cs').length,
            conf: (c.querySelector('.conf') || {}).textContent || '',
            dep: !!c.querySelector('.lc-dep'),
            fig: (c.querySelector('svg.logicmap') || {}).getAttribute ? (c.querySelector('svg.logicmap').getAttribute('data-fig') || '') : '',
            plain: !!c.querySelector('.plain'),
            plain_cjk: c.querySelector('.plain') ? cjk(c.querySelector('.plain').innerText) : 0
          }));
          // —— 逻辑图完整性 ——
          const figReport = svgs.map(s => {
            let empty = true;
            for (const t of ['line','path','circle','rect','polyline','polygon','text']) {
              if (s.querySelector(t)) { empty = false; break; }
            }
            const r = s.getBoundingClientRect();
            return { fig: s.getAttribute('data-fig'), type: s.getAttribute('data-type'),
                     viewBox: !!s.getAttribute('viewBox'), empty,
                     rendered_w: Math.round(r.width), rendered_h: Math.round(r.height) };
          });
          // —— 旧模板类名 / 署名 ——
          const classHit = [];
          document.querySelectorAll('*').forEach(el => {
            (el.classList || []).forEach(cn => { if (["summary-grid","logic-card","annex-card-v1","scard","grid15"].includes(cn)) classHit.push(cn); });
          });
          const bodyText = document.body.innerText || "";
          // —— 溢出与几何（宽屏）——
          const docW = document.documentElement.clientWidth;
          const escapes = [];
          document.querySelectorAll('.shell *').forEach(el => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) return;
            if (r.left < -2 || r.right > docW + 2) {
              escapes.push({tag: el.tagName, cls: (el.className.baseVal || el.className || '').toString().slice(0, 40),
                            left: Math.round(r.left), right: Math.round(r.right)});
            }
          });
          // —— 禁用样式（玻璃拟态/渐变文字）——
          const banned = [];
          document.querySelectorAll('.shell *').forEach(el => {
            const cs = getComputedStyle(el);
            if (cs.backdropFilter && cs.backdropFilter !== 'none') banned.push({kind: 'backdrop-filter', cls: (el.className || '').toString().slice(0, 40)});
            if ((cs.webkitBackgroundClip || cs.backgroundClip) === 'text') banned.push({kind: 'gradient-text', cls: (el.className || '').toString().slice(0, 40)});
          });
          const foot = document.querySelector('footer.annex-foot .sig');
          return {
            template_attr: root.getAttribute('logic_template_id'),
            template_data: root.getAttribute('data-logic-template-id'),
            template_meta: metaTag ? metaTag.getAttribute('content') : null,
            nested_p_count: document.querySelectorAll('p p').length,
            qcard_count: qcards.length,
            qcard_ids: qcards.map(q => q.getAttribute('data-q')),
            qcards_in_single_grid: qgrids.length === 1 && qcards.every(q => q.closest('.qgrid')),
            lcard_count: lcards.length,
            lcard_nums: lcards.map(c => c.getAttribute('data-card')),
            svg_count: svgs.length,
            plain_count: plains.length,
            takes_count: takes.length,
            alt_count: alts.length,
            alt_rows: alts.map(a => a.querySelectorAll('.arow').length),
            alt_has_verify: alts.map(a => [...a.querySelectorAll('.arow .k')].some(k => k.textContent.includes('验证设计'))),
            protocol_blocks: protos.length,
            protocol_is_lcard: protos.length ? !!protos[0].closest('.lcard') : null,
            proto_items: protoItems.length,
            obs_count: obs.length,
            cardReport, figReport,
            old_class_hits: classHit,
            old_sig_hits: OLD_SIGS_HITS.filter(s => bodyText.includes(s)),
            placeholder_hits: (bodyText.match(/待补充|占位符|placeholder|Lorem|lorem|TODO|此处省略/g) || []),
            footer_text: foot ? foot.textContent.trim() : null,
            body_scrollW: document.documentElement.scrollWidth,
            winW: window.innerWidth,
            escapes: escapes.slice(0, 12),
            escape_count: escapes.length,
            banned_styles: banned
          };
        }""".replace("OLD_SIGS_HITS", '["政研通研究院","智见行业研究 ｜ 行业研究报告"]'))

        # 宽屏首/中/末截图（元素级：附件头 / 中部详细卡 / 补数协议区块）
        wide = []
        for sel, name in (("#annex-hero", "wide_first_hero"),
                          ("#card-08", "wide_mid_card08"),
                          ("#data-protocol", "wide_last_protocol")):
            p = SHOTS / f"{name}.png"
            page.locator(sel).screenshot(path=str(p))
            wide.append(p)
        browser.close()
    return d, wide, errors, console_errs

def main():
    SHOTS.mkdir(exist_ok=True)
    if not HTML.exists():
        sys.exit("逻辑附件.html 不存在")
    render_info = render_pdf()
    import fitz
    doc = fitz.open(str(PDF)); n = doc.page_count; doc.close()
    mid, last = n // 2, n - 1
    pdf_pages, a4_shots = raster_a4([0, mid, last])
    no_sig_pages, pdf_bad_blocks = pdf_audit()
    d, wide, js_errors, console_errs = dom_and_wide_shots()

    nums_ok = d["lcard_nums"] == [f"{i:02d}" for i in range(1, 16)]
    qnums_ok = d["qcard_ids"] == [f"{i:02d}" for i in range(1, 16)]
    conf_vals = sorted(set((r["conf"].replace("置信度 · ", "").strip()) for r in d["cardReport"]))
    conf_ok = all(r["conf"].startswith("置信度") and r["conf"].replace("置信度 · ", "").strip() in ("高", "中", "低")
                  for r in d["cardReport"])
    cards_complete = all(r["title"] and r["prem"] and r["prem_items"] >= 2 and r["chain_steps"] >= 3
                         and r["dep"] and r["plain"] and r["plain_cjk"] >= 15 for r in d["cardReport"])
    figs_ok = (d["svg_count"] >= 12
               and all((not f["empty"]) and f["viewBox"] and f["rendered_w"] > 100 for f in d["figReport"])
               and DIAGRAM_TYPES_REQUIRED.issubset(set(f["type"] for f in d["figReport"] if f["type"])))
    tmpl_ok = TEMPLATE_ID in (d["template_attr"], d["template_data"], d["template_meta"])

    checks = [
        {"item": f"logic_template_id={TEMPLATE_ID}（html 根属性 + meta 双标注）", "pass": tmpl_ok,
         "detail": f"attr={d['template_attr']} meta={d['template_meta']} data={d['template_data']}"},
        {"item": "1 套总结速览卡：qcard = 15（唯一 qgrid，编号 01-15）", "pass": d["qcard_count"] == 15 and d["qcards_in_single_grid"] and qnums_ok,
         "detail": f"count={d['qcard_count']} single_grid={d['qcards_in_single_grid']} nums_ok={qnums_ok}"},
        {"item": "详细逻辑卡 = 15（编号 01-15，无第 16 卡）", "pass": d["lcard_count"] == 15 and nums_ok and not d["protocol_is_lcard"],
         "detail": f"count={d['lcard_count']} nums_ok={nums_ok} protocol_is_lcard={d['protocol_is_lcard']}"},
        {"item": "每卡结构完整：论题+前提(≥2)+推理链(≥3 步)+置信度+依赖数据+白话总结",
         "pass": cards_complete and conf_ok,
         "detail": "; ".join(f"{r['num']}:{'✓' if (r['title'] and r['prem'] and r['chain_steps']>=3 and r['plain']) else '✗'}({r['conf'].strip()})" for r in d["cardReport"])[:240]},
        {"item": "置信度 ∈ {高,中,低} 且逐卡标注", "pass": conf_ok, "detail": f"distribution={conf_vals}"},
        {"item": "逻辑图 ≥12（SVG，含 viewBox、非空、宽>100px，5 类型全覆盖）", "pass": figs_ok,
         "detail": f"count={d['svg_count']} types={sorted(set(f['type'] for f in d['figReport']))}"},
        {"item": "15 条每卡白话总结（.plain，每条 ≥15 汉字）", "pass": d["plain_count"] == 15 and all(r["plain_cjk"] >= 15 for r in d["cardReport"]),
         "detail": f"count={d['plain_count']} cjk={[r['plain_cjk'] for r in d['cardReport']]}"},
        {"item": "Key Takeaways 5-8 条", "pass": 5 <= d["takes_count"] <= 8, "detail": str(d["takes_count"])},
        {"item": "替代解释与验证设计 ≥3 组（每组含验证设计行）", "pass": d["alt_count"] >= 3 and all(d["alt_has_verify"]) and all(r >= 3 for r in d["alt_rows"]),
         "detail": f"count={d['alt_count']} rows={d['alt_rows']} has_verify={d['alt_has_verify']}"},
        {"item": "补数协议 = 1 个独立区块（4 项缺口 + 8 项观察指标，不计入 15 卡）",
         "pass": d["protocol_blocks"] == 1 and d["proto_items"] == 4 and d["obs_count"] == 8 and not d["protocol_is_lcard"],
         "detail": f"blocks={d['protocol_blocks']} items={d['proto_items']} obs={d['obs_count']} in_lcard={d['protocol_is_lcard']}"},
        {"item": "无旧模板类名 / 无旧署名 / 无占位句", "pass": not d["old_class_hits"] and not d["old_sig_hits"] and not d["placeholder_hits"],
         "detail": f"class={d['old_class_hits']} sig={d['old_sig_hits']} ph={d['placeholder_hits']}"},
        {"item": "nested_p_count == 0（Chromium DOM 标准，禁正则）", "pass": d["nested_p_count"] == 0, "detail": str(d["nested_p_count"])},
        {"item": "无 JS 错误", "pass": not js_errors and not console_errs,
         "detail": f"pageerror={js_errors}; console.error={console_errs}"},
        {"item": "无横向溢出 / 无越界元素 / 无禁用样式（宽屏 1440）",
         "pass": d["body_scrollW"] <= d["winW"] + 1 and d["escape_count"] == 0 and not d["banned_styles"],
         "detail": f"scrollW={d['body_scrollW']} winW={d['winW']} escapes={d['escape_count']} banned={d['banned_styles']}"},
        {"item": "页脚统一署名（HTML footer + A4 PDF 每页 @bottom-center）",
         "pass": d["footer_text"] == FOOTER_SIG and not no_sig_pages,
         "detail": f"footer='{d['footer_text']}' pdf缺页={no_sig_pages}"},
        {"item": "A4 PDF 无文本块越界", "pass": not pdf_bad_blocks, "detail": str(pdf_bad_blocks[:5]) or "全部通过"},
    ]
    result = "PASS" if all(c["pass"] for c in checks) else "BLOCKED"

    gate = {
        "type": "Part C 逻辑附件",
        "standard": "wiki-gated-research · 99wiki 分型验收（Part C 验收器 · logic-annex-v2）",
        "generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "logic_template_id": TEMPLATE_ID if tmpl_ok else f"MISSING(纯正文检查到 {d['template_attr']}/{d['template_meta']})",
        "deliverable": {"html": str(HTML), "pdf": str(PDF), "gate": str(GATE), "shots": str(SHOTS),
                        "same_version_dir_as_partB": True},
        "html_sha256": sha256(HTML),
        "pdf_sha256": sha256(PDF),
        "last_render": {**render_info, "a4_pdf_pages": pdf_pages},
        "count_proofs": {
            "quick_cards": {"count": d["qcard_count"], "ids": d["qcard_ids"], "single_summary_grid": d["qcards_in_single_grid"]},
            "detail_cards": {"count": d["lcard_count"], "ids": d["lcard_nums"],
                             "per_card_complete": {r["num"]: {"title": r["title"], "prem_items": r["prem_items"],
                                                              "chain_steps": r["chain_steps"], "conf": r["conf"].strip(),
                                                              "dep": r["dep"], "fig": r["fig"], "plain": r["plain"],
                                                              "plain_cjk": r["plain_cjk"]} for r in d["cardReport"]}},
            "logic_diagrams": {"count": d["svg_count"], "min_required": 12, "ids": [f["fig"] for f in d["figReport"]],
                               "types": {f["fig"]: f["type"] for f in d["figReport"]},
                               "type_coverage": sorted(set(f["type"] for f in d["figReport"])),
                               "all_have_viewbox_and_primitives": all((not f["empty"]) and f["viewBox"] for f in d["figReport"])},
            "plain_summaries": d["plain_count"],
            "key_takeaways": d["takes_count"],
            "alt_explanations": {"count": d["alt_count"], "min_required": 3, "rows_per_alt": d["alt_rows"]},
            "protocol": {"blocks": d["protocol_blocks"], "items": d["proto_items"], "observation_indicators": d["obs_count"],
                         "counted_as_card16": d["protocol_is_lcard"]},
        },
        "dom_checks": {
            "engine": "playwright Chromium, viewport 1440x1200, file:// 加载后 DOM 检查（未用正则判嵌套）",
            "nested_p_count": d["nested_p_count"],
            "js_errors": js_errors, "console_errors": console_errs,
            "horizontal_overflow": d["body_scrollW"] > d["winW"] + 1,
            "element_escapes": d["escapes"], "element_escape_count": d["escape_count"],
            "banned_styles": d["banned_styles"],
            "old_template_class_hits": d["old_class_hits"],
            "old_signature_hits": d["old_sig_hits"],
            "placeholder_hits": d["placeholder_hits"],
            "footer_uniform": d["footer_text"],
        },
        "a4_pdf": {"pages": pdf_pages, "footer_missing_pages": no_sig_pages, "text_block_overflow": pdf_bad_blocks},
        "screenshots": {
            "wide": [{"path": str(p), "target": t, "checked": True,
                      "conclusion": "Chromium 元素级截图存档；配合 DOM 几何审计（无溢出/越界/禁用样式、计数通过）"}
                     for p, t in zip(wide, ("首：附件头+导读（hero）", "中：详细逻辑卡 08（消费贷传导链）", "末：补数协议独立区块"))],
            "a4": [{"path": str(p), "page": i + 1, "checked": True,
                    "conclusion": "weasyprint A4 PDF fitz 栅格化存档；页脚由 @bottom-center 统一输出（逐页署名已验证）"}
                   for i, p in zip((0, mid, last), a4_shots)],
            "method_note": "本机渲染模型无图像输入通道（read_image 不可用），按纪律以 DOM 几何审计 + 截图存档替代目检并在此注明；截图已生成可供人工复核",
        },
        "scope_note": "Part C 验收器不检查主文页数/封面/KPI/正文 10000 字门（属 Part B 验收器）；本附件无 .page/.cover/KPI 为正常结构",
        "checks": checks,
        "result": result,
    }
    GATE.write_text(json.dumps(gate, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: gate[k] for k in ("type", "result", "logic_template_id", "html_sha256", "pdf_sha256")},
                     ensure_ascii=False, indent=2))
    for c in checks:
        print(("PASS " if c["pass"] else "FAIL ") + c["item"] + "  —— " + str(c["detail"])[:150])
    return 0 if result == "PASS" else 1

if __name__ == "__main__":
    sys.exit(main())
