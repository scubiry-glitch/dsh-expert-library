#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""分型验收（DOM 优先，Chromium 加载后检查）—— wiki-gated-research
Usage: python3 accept_check.py <part:B|C> <html_path> [label]
检查项按 SKILL 分型：Part B 主文验收器 / Part C 附件验收器。
输出：<html 同名>_accept_<part>.json + 打印 PASS/FAIL 明细
"""
import sys, json, re, os, time

PART = sys.argv[1].upper()
HTML = sys.argv[2]
LABEL = sys.argv[3] if len(sys.argv) > 3 else PART

from playwright.sync_api import sync_playwright

def find_chromium():
    import glob
    cands = []
    for pat in ["/root/.cache/ms-playwright/chromium-*/chrome-linux*/chrome",
                "/root/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell",
                "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
                "/root/.openclaw/workspace/node_modules/.remotion/chrome-headless-shell"]:
        cands += glob.glob(pat)
    for c in cands:
        if os.path.exists(c):
            return c
    return None

JS = """
() => {
  const doc = document;
  const text = doc.body.innerText || '';
  const cjk = (text.match(/[\\u4e00-\\u9fff]/g) || []).length;
  // 正文（排除封面块）
  const cover = doc.querySelector('.cover');
  let bodyCjk = cjk;
  if (cover) {
    const coverText = cover.innerText || '';
    bodyCjk = cjk - (coverText.match(/[\\u4e00-\\u9fff]/g) || []).length;
  }
  // 溢出：最宽元素
  let maxRight = 0, maxEl = '';
  doc.querySelectorAll('body *').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.right > maxRight) { maxRight = r.right; maxEl = el.tagName + '.' + (el.className || ''); }
  });
  const overflow = doc.documentElement.scrollWidth - doc.documentElement.clientWidth;
  return {
    cjk: cjk, bodyCjk: bodyCjk,
    nestedP: doc.querySelectorAll('p p').length,
    tables: doc.querySelectorAll('table').length,
    svgs: doc.querySelectorAll('svg').length,
    kpiCards: doc.querySelectorAll('.kpi-card').length,
    cover: !!doc.querySelector('.cover'),
    h2: doc.querySelectorAll('h2').length, h3: doc.querySelectorAll('h3').length,
    maxRight: Math.round(maxRight), overflow: overflow,
    hasKeyTakeaways: /Key Takeaways/.test(text),
    hasAltExpl: /替代解释/.test(text),
    hasProtocol: /补数协议/.test(text),
    hasLogicId: /logic_template_id\\s*=\\s*logic-annex-v2/.test(text),
    // 卡计数按 DOM 结构：S/P 卡为 <strong>S1…/P1…> 前缀，D 卡为 h3 前缀（innerText 无 ** 星号）
    sCards: Array.from(doc.querySelectorAll('strong')).filter(el => /^S\\d+\\s/.test(el.innerText.trim())).length,
    dCards: Array.from(doc.querySelectorAll('h3')).filter(el => /^D\\d+\\s/.test(el.innerText.trim())).length,
    pCards: Array.from(doc.querySelectorAll('strong')).filter(el => /^P\\d+$/.test(el.innerText.trim())).length,
    oldClass: /logic-annex-v1|annex-v1/.test(doc.documentElement.innerHTML),
    placeholder: /(TODO|占位|待补内容|lorem|XXX)/i.test(text),
    hText: Array.from(doc.querySelectorAll('h1,h2,h3')).map(h => h.innerText.trim()).slice(0, 60),
  };
}
"""

def run():
    results = {}
    with sync_playwright() as p:
        exe = find_chromium()
        if exe:
            browser = p.chromium.launch(executable_path=exe)
        else:
            browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.goto("file://" + os.path.abspath(HTML), wait_until="load")
        page.wait_for_timeout(300)
        d = page.evaluate(JS)
        browser.close()
    d["jsErrors"] = errors

    ok = lambda name, cond, detail="": results.update({name: {"pass": bool(cond), "detail": detail}})

    if PART == "B":
        ok("封面结构", d["cover"], "cover 存在")
        ok("KPI 数量=4", d["kpiCards"] == 4, f"kpiCards={d['kpiCards']}")
        ok("正文中文字符>=10000", d["bodyCjk"] >= 10000, f"bodyCjk={d['bodyCjk']} (含封面 {d['cjk']})")
        ok("表格>=4", d["tables"] >= 4, f"tables={d['tables']}")
        ok("SVG 机制图/决策树>=4", d["svgs"] >= 4, f"svgs={d['svgs']}")
        ok("量化模型章节", any("量化模型" in h or "量化测算" in h for h in d["hText"]), str(d["hText"][:20]))
        ok("决策树章节", any("决策树" in h or "验证窗口" in h for h in d["hText"]), "")
        ok("结论/风险/附录章节", all(any(k in h for h in d["hText"]) for k in ["结论", "风险提示", "附录"]), "")
        ok("无 p 嵌套", d["nestedP"] == 0, f"nestedP={d['nestedP']}")
        ok("无占位句", not d["placeholder"], "")
        ok("无 JS 错误", len(errors) == 0, str(errors[:3]))
        ok("无横向溢出", d["overflow"] <= 2, f"overflow={d['overflow']}, maxRight={d['maxRight']} (viewport 1280)")
    else:
        ok("logic-annex-v2 标识", d["hasLogicId"], "")
        ok("速览卡 S=15", d["sCards"] == 15, f"sCards={d['sCards']}")
        ok("详细卡 D=15", d["dCards"] == 15, f"dCards={d['dCards']}")
        ok("逻辑图 SVG>=12", d["svgs"] >= 12, f"svgs={d['svgs']}")
        ok("白话总结 P=15", d["pCards"] == 15, f"pCards={d['pCards']}")
        ok("Key Takeaways", d["hasKeyTakeaways"], "")
        ok("替代解释", d["hasAltExpl"], "")
        ok("独立补数协议", d["hasProtocol"], "")
        ok("无旧模板类名", not d["oldClass"], "")
        ok("无第二套 summary grid", d["sCards"] <= 15 and d["pCards"] <= 15, "")
        ok("无 p 嵌套", d["nestedP"] == 0, f"nestedP={d['nestedP']}")
        ok("无占位句", not d["placeholder"], "")
        ok("无 JS 错误", len(errors) == 0, str(errors[:3]))
        ok("无横向溢出", d["overflow"] <= 2, f"overflow={d['overflow']}, maxRight={d['maxRight']} (viewport 1280)")

    passed = sum(1 for v in results.values() if v["pass"])
    total = len(results)
    verdict = "PASS" if passed == total else "FAIL"
    out = {
        "part": PART, "label": LABEL, "html": HTML, "verdict": verdict,
        "passed": passed, "total": total, "items": results,
        "checked_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "method": "playwright chromium DOM-first（禁止正则判 HTML 嵌套；溢出/JS/数量均以加载后 DOM 为准）",
    }
    with open(os.path.splitext(HTML)[0] + f"_accept_{PART}.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(json.dumps(out, ensure_ascii=False, indent=2))
    sys.exit(0 if verdict == "PASS" else 2)

if __name__ == "__main__":
    run()
