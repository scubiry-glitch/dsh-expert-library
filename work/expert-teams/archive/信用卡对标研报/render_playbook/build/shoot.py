# -*- coding: utf-8 -*-
"""渲染门 G3：playwright 1280 全页截图 + 0 溢出/0 裁切/0 重叠/锚点审计（打法研究 v1 · 9 节 + 6 图）"""
import pathlib, json
from playwright.sync_api import sync_playwright

BASE = pathlib.Path("/root/zhijian/dsh-expert-library/work/expert-teams/信用卡对标研报/render_playbook")
HTML_PATH = BASE / "别人的打法_溯源与迁移_20260830.html"
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
  // 组件内部横向裁切（矩阵宽表 + 泳道图 + 时序条重点）
  for (const el of document.querySelectorAll('figure.chart, .numstrip, table, .panel, .meta-line, .cv-nav, .bk-block, blockquote, .lane, .lane-items, .tl-span, .tl-cards, .panorama-table, .matrix-table')) {
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
  chk('.fn-name', '.fn-head'); chk('.fn-val', '.fn-head'); chk('.fn-scale', '.fn-track');
  chk('.fn-reg', '.fn-track'); chk('.fn-sub', '.fn-row');
  chk('.lev-lab', '.lev-row'); chk('.lev-val', '.lev-row'); chk('.lev-badge', 'figure');
  chk('.im-lab', '.inc-mini'); chk('.im-val', '.inc-mini');
  chk('.clr-label', '.clr-row'); chk('.clr-val', '.clr-row'); chk('.clr-dot', '.clr-zone');
  chk('.tl-bar b', '.tl-bar'); chk('.tl-endpoint', '.tl-span'); chk('.tl-date', '.tl-card');
  chk('.lane-n', '.lane-head'); chk('.itm', '.lane-items');
  chk('.lv', 'td'); chk('.lv', 'p');
  // 数字条四格纵向重叠检测（兄弟 cell 边界相交）
  const cells = [...document.querySelectorAll('.numcell')].map(e => e.getBoundingClientRect());
  for (let i = 1; i < cells.length; i++)
    if (cells[i].left < cells[i-1].right - 1) issues.overlap.push(['numcell', i]);
  // 泳道行重叠检测（行内 chip 不越行界）
  const lanes = [...document.querySelectorAll('.lane')].map(e => e.getBoundingClientRect());
  for (let i = 1; i < lanes.length; i++)
    if (lanes[i].top < lanes[i-1].bottom - 1) issues.overlap.push(['lane', i]);
  // 时序条卡重叠检测
  const tcs = [...document.querySelectorAll('.tl-card')].map(e => e.getBoundingClientRect());
  for (let i = 1; i < tcs.length; i++)
    if (tcs[i].left < tcs[i-1].right - 1) issues.overlap.push(['tl-card', i]);
  // 泳道条目计数审计（矩阵行 → 泳道：4+9+1+1+2 矩阵行 + 参照/前瞻 2 = 19 矩阵行全覆盖）
  issues.laneChips = [...document.querySelectorAll('.lane')].map(
    l => [l.querySelector('.lane-head b').textContent, l.querySelectorAll('.itm').length]);
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
      for (let i = 0; i < 9; i++) t.push(document.getElementById('s' + i).getBoundingClientRect().top + window.scrollY);
      t.push(document.getElementById('backcover').getBoundingClientRect().top + window.scrollY);
      return t;
    }""")
    names = ["s0-卷首", "s1-一-获客流量", "s2-二-资产端", "s3-三-收入结构",
             "s4-四-风险出清", "s5-五-组织机制", "s6-六-迁移矩阵",
             "s7-局限与待补", "s8-来源披露"]
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
