# -*- coding: utf-8 -*-
"""渲染门 G3：playwright 1280 全页截图 + 0 溢出/0 裁切/锚点审计"""
import pathlib, json
from playwright.sync_api import sync_playwright

BASE = pathlib.Path("/root/zhijian/dsh-expert-library/work/expert-teams/信用卡对标研报/render")
HTML_PATH = BASE / "研报主文_信用卡对标_20260830.html"
SHOTS = BASE / "shots"
SHOTS.mkdir(exist_ok=True)

AUDIT = """
() => {
  const vw = document.documentElement.clientWidth;
  const issues = {hOverflow: [], clip: [], labelOut: [], docW: vw};
  const all = document.querySelectorAll('body *');
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > vw + 1 && !el.closest('.rail'))
      issues.hOverflow.push([el.tagName + '.' + (el.className||'').toString().slice(0,40),
                             Math.round(r.right), Math.round(r.left)]);
  }
  // 组件内部横向裁切
  for (const el of document.querySelectorAll('figure.chart, .numstrip, table, .or-wrap, .panel, .risk-strip, .meta-line, .cv-nav, .bk-block')) {
    if (el.scrollWidth > el.clientWidth + 2)
      issues.clip.push([el.tagName + '.' + el.className, el.scrollWidth, el.clientWidth]);
  }
  // 图内标签越界（相对其定位容器）
  const chk = (sel, cont) => {
    for (const el of document.querySelectorAll(sel)) {
      const a = el.getBoundingClientRect();
      const c = el.closest(cont);
      if (!c) return;
      const cr = c.getBoundingClientRect();
      if (a.right > cr.right + 2 || a.left < cr.left - 2)
        issues.labelOut.push([sel, el.textContent.trim().slice(0, 20),
                              Math.round(a.left - cr.left), Math.round(a.right - cr.right)]);
    }
  };
  chk('.pval', '.pz'); chk('.pmiss', '.pz');
  chk('.wflab', '.wfcol'); chk('.dval', '.drow'); chk('.dlabel', '.drow');
  chk('.mcap', '.mrow'); chk('.gcard', '.grow-row');
  // 锚点
  const missing = [];
  document.querySelectorAll('.rail-nav a').forEach(a => {
    const id = a.getAttribute('href').slice(1);
    if (!document.getElementById(id)) missing.push(id);
  });
  issues.missingAnchors = missing;
  issues.pageH = Math.round(document.documentElement.scrollHeight);
  return issues;
}
"""

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/root/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell")
    pg = b.new_page(viewport={"width": 1280, "height": 960})
    pg.goto(HTML_PATH.as_uri())
    pg.wait_for_timeout(700)
    pg.evaluate("document.fonts && document.fonts.ready")
    pg.wait_for_timeout(300)
    issues = pg.evaluate(AUDIT)
    print(json.dumps(issues, ensure_ascii=False, indent=1))
    # 分区截图
    pg.screenshot(path=str(SHOTS / "00-cover.png"), clip={"x": 212, "y": 0,
                  "width": 1280 - 212, "height": min(1400, issues["pageH"])})
    # 分区截图：h2 即节锚点，按文档坐标截「本节标题 → 下一节标题」整段
    tops = pg.evaluate("""() => {
      const t = [];
      for (let i = 0; i < 9; i++) t.push(document.getElementById('s' + i).getBoundingClientRect().top + window.scrollY);
      t.push(document.getElementById('backcover').getBoundingClientRect().top + window.scrollY);
      return t;
    }""")
    names = ["s0-卷首速览", "s1-总论", "s2-第一章", "s3-第二章", "s4-第三章",
             "s5-第四章", "s6-第五章", "s7-总结", "s8-来源披露"]
    for i, name in enumerate(names):
        top, bottom = tops[i], tops[i + 1]
        pg.screenshot(path=str(SHOTS / f"{name}.png"),
                      clip={"x": 0, "y": max(0, top - 8), "width": 1280,
                            "height": min(bottom - top + 16, 15800)},
                      full_page=True)
    pg.locator("#backcover").screenshot(path=str(SHOTS / "09-backcover.png"))
    try:
        pg.screenshot(path=str(SHOTS / "full-1280.png"), full_page=True)
        print("full-page screenshot ok")
    except Exception as e:
        print("full-page failed:", e)
    b.close()
