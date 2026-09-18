#!/usr/bin/env python3
# geometry audit: 1280 / 375 — overflow, clipping, footer visibility, full-page screenshots
import json, os, sys
from playwright.sync_api import sync_playwright

FILE = os.path.abspath(sys.argv[1])
OUTDIR = os.path.abspath(sys.argv[2])
URL = 'file://' + FILE

JS = """
() => {
  const vw = document.documentElement.clientWidth;
  const issues = [];
  const sw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  if (sw > vw + 1) issues.push(`page scrollWidth ${sw} > viewport ${vw}`);
  const all = document.querySelectorAll('body *');
  const bad = [];
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    let clipped = false;
    let p = el.parentElement;
    while (p) {
      const pcs = getComputedStyle(p);
      if (/(auto|scroll|clip|hidden)/.test(pcs.overflowX)) { clipped = true; break; }
      p = p.parentElement;
    }
    if (!clipped && (r.right > vw + 1 || r.left < -1)) {
      bad.push(`${el.tagName.toLowerCase()}.${(el.className && el.className.toString().split(' ')[0]) || ''} right=${Math.round(r.right)} left=${Math.round(r.left)}`);
      if (bad.length > 8) break;
    }
  }
  const clippedText = [];
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.overflowY === 'hidden' && el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0) {
      const r = el.getBoundingClientRect();
      if (r.height > 0 && el.textContent.trim().length > 0) clippedText.push(`${el.tagName.toLowerCase()}.${(el.className && el.className.toString().split(' ')[0]) || ''} sh=${el.scrollHeight} ch=${el.clientHeight}`);
      if (clippedText.length > 8) break;
    }
  }
  const f = document.querySelector('.shell-footer');
  let footer = null;
  if (f) {
    const r = f.getBoundingClientRect();
    const cs = getComputedStyle(f);
    footer = {
      visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.height > 0 && r.width > 0,
      text: f.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80),
      height: Math.round(r.height),
    };
  }
  const toc = [...document.querySelectorAll('.toc-strip a')];
  const dead = toc.filter(a => !document.querySelector(a.getAttribute('href'))).map(a => a.getAttribute('href'));
  const sections = document.querySelectorAll('section').length;
  const chapters = [...document.querySelectorAll('.chapter .cno')].map(e => e.textContent.trim());
  return { vw, sw, issues, bad, clippedText, footer, deadAnchors: dead, sections, chapters };
}
"""

report = {}
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome')
    for name, width, height in [('desktop-1280', 1280, 900), ('mobile-375', 375, 812)]:
        page = browser.new_page(viewport={'width': width, 'height': height})
        page.goto(URL, wait_until='networkidle')
        page.wait_for_timeout(400)
        res = page.evaluate(JS)
        page.screenshot(path=os.path.join(OUTDIR, f'{name}.png'), full_page=True)
        report[name] = res
        page.close()
    browser.close()
print(json.dumps(report, ensure_ascii=False, indent=1))
