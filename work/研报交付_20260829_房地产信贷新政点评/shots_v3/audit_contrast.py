#!/usr/bin/env python3
# contrast AA + sibling overlap + rendered-content audit (1280 & 375)
import json, os, sys
from playwright.sync_api import sync_playwright

FILE = os.path.abspath(sys.argv[1])
URL = 'file://' + FILE

JS = """
() => {
  function lum(rgb) {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  }
  function lumCss(c) { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(',').map(parseFloat); return lum(p.slice(0, 3)); }
  function parse(c) { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(',').map(parseFloat); return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; }
  function blend(top, bottom) { return top.rgb.map((v, i) => Math.round(v * top.a + bottom[i] * (1 - top.a))); }
  function bgOf(el) {
    let acc = [252, 253, 251]; // page bg
    const chain = [];
    let p = el;
    while (p) { chain.unshift(p); p = p.parentElement; }
    for (const node of chain) {
      const bg = getComputedStyle(node).backgroundColor;
      const c = bg ? parse(bg) : null;
      if (c && c.a > 0) {
        if (c.a >= 1) { acc = c.rgb; }
        acc = blend(c, acc);
      }
    }
    return acc;
  }
  const fails = [];
  const textEls = document.querySelectorAll('p, h1, h2, h3, h4, td, th, li, span, a, div');
  const seen = new Set();
  for (const el of textEls) {
    if (el.children.length > 0) continue;
    const t = el.textContent.trim(); if (!t) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.4) continue;
    const r = el.getBoundingClientRect(); if (r.width === 0) continue;
    const fg = lumCss(cs.color); const bg = lum(bgOf(el));
    if (fg === null || bg === null) continue;
    const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    const size = parseFloat(cs.fontSize); const bold = parseInt(cs.fontWeight) >= 700;
    const need = (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5;
    const key = t.slice(0, 24) + cs.color + bgOf(el);
    if (ratio < need && !seen.has(key)) { seen.add(key); fails.push(`contrast ${ratio.toFixed(2)}<${need} "${t.slice(0, 18)}" color=${cs.color} bg=${bgOf(el).join(",")} size=${size}px`); if (fails.length > 12) break; }
  }
  // sibling chapter blocks must not overlap
  const overlaps = [];
  const chs = [...document.querySelectorAll('.chapter')];
  for (let i = 0; i < chs.length - 1; i++) {
    const a = chs[i].getBoundingClientRect(), b = chs[i + 1].getBoundingClientRect();
    if (a.bottom > b.top + 2) overlaps.push(`chapter ${i + 1} overlaps ${i + 2}`);
  }
  // each chapter renders heading + content
  const chapters = [...document.querySelectorAll('.chapter')].map((c, i) => {
    const h = c.querySelector('h3') || c.querySelector('h2');
    const body = c.innerText.replace(/\\s+/g, '').length;
    if (!h) return { i: i + 1, heading: '', headingW: 0, bodyChars: body };
    const hr = h.getBoundingClientRect();
    return { i: i + 1, heading: h.textContent.slice(0, 12), headingW: Math.round(hr.width), bodyChars: body };
  });
  return { contrastFails: fails, overlaps, chapters };
}
"""

report = {}
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome')
    for name, width, height in [('desktop-1280', 1280, 900), ('mobile-375', 375, 812)]:
        page = browser.new_page(viewport={'width': width, 'height': height})
        page.goto(URL, wait_until='networkidle')
        page.wait_for_timeout(300)
        report[name] = page.evaluate(JS)
        page.close()
    browser.close()
print(json.dumps(report, ensure_ascii=False, indent=1))
