# -*- coding: utf-8 -*-
"""渲染门 G3：playwright 1280 全页截图 + 0 溢出/0 裁切/0 重叠/锚点审计（UE 专题 v3 · 7 节 + 5 图）"""
import pathlib, json
from playwright.sync_api import sync_playwright

BASE = pathlib.Path("/root/zhijian/dsh-expert-library/work/expert-teams/信用卡对标研报/render_ue")
HTML_PATH = BASE / "UE视角分析_信用卡_20260830.html"
SHOTS = BASE / "shots"
SHOTS.mkdir(exist_ok=True)

AUDIT = """
() => {
  const vw = document.documentElement.clientWidth;
  const issues = {hOverflow: [], clip: [], labelOut: [], overlap: [], docW: vw};
  const all = document.querySelectorAll('body *');
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > vw + 1 && !el.closest('.rail'))
      issues.hOverflow.push([el.tagName + '.' + (el.className||'').toString().slice(0,40),
                             Math.round(r.right), Math.round(r.left)]);
  }
  // 组件内部横向裁切（宽表 + 阶梯图重点）
  for (const el of document.querySelectorAll('figure.chart, .numstrip, table, .panel, .meta-line, .cv-nav, .bk-block, blockquote, .stairs, .stair-foot')) {
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
  chk('.wflab', '.wfcol'); chk('.dval', '.drow'); chk('.dlabel', '.drow');
  chk('.eval', '.erow'); chk('.ebadge', '.erow'); chk('.elab', '.erow');
  chk('.mtag', '.mhead'); chk('.mline i', '.mbody'); chk('.lv', 'td');
  chk('.fdiv-label', '.fdiv-row'); chk('.fdiv-val', '.fdiv-row');   // v3 发散条
  chk('.sval', '.stepblk'); chk('.sfrozen', '.stepcol');            // v3 阶梯图
  chk('.sobs', '.sfcol'); chk('.sname', '.sfcol');
  chk('.gk', '.grow'); chk('.gv', '.grow'); chk('.gpri', '.ghead'); // v3 四抓手卡阵
  // 数字条四格纵向重叠检测（兄弟 cell 边界相交）
  const cells = [...document.querySelectorAll('.numcell')].map(e => e.getBoundingClientRect());
  for (let i = 1; i < cells.length; i++)
    if (cells[i].left < cells[i-1].right - 1) issues.overlap.push(['numcell', i]);
  // 阶梯图四级列重叠检测
  const scols = [...document.querySelectorAll('.sfcol')].map(e => e.getBoundingClientRect());
  for (let i = 1; i < scols.length; i++)
    if (scols[i].left < scols[i-1].right - 1) issues.overlap.push(['sfcol', i]);
  // 阶梯高度比例抽检（2:1:1:0 视觉化：s1 ≈ 2×s2，s4 最低）
  const hs = ['s1','s2','s3','s4'].map(k => document.querySelector('.stepblk.' + k).getBoundingClientRect().height);
  issues.stairHeights = hs.map(h => Math.round(h));
  issues.missingAnchors = [];
  document.querySelectorAll('.rail-nav a').forEach(a => {
    const id = a.getAttribute('href').slice(1);
    if (!document.getElementById(id)) issues.missingAnchors.push(id);
  });
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
    # 封面截图
    pg.screenshot(path=str(SHOTS / "00-cover.png"), clip={"x": 212, "y": 0,
                  "width": 1280 - 212, "height": min(1400, issues["pageH"])})
    # 分区截图：h2 即节锚点，按文档坐标截「本节标题 → 下一节标题」整段
    tops = pg.evaluate("""() => {
      const t = [];
      for (let i = 0; i < 7; i++) t.push(document.getElementById('s' + i).getBoundingClientRect().top + window.scrollY);
      t.push(document.getElementById('backcover').getBoundingClientRect().top + window.scrollY);
      return t;
    }""")
    names = ["s0-卷首", "s1-一-现状诊断", "s2-二-客群端", "s3-三-产品端",
             "s4-四-行动", "s5-局限与待补", "s6-来源披露"]
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
