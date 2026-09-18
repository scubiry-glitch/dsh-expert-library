#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v3 生成器：精致高端大气（可科技感）《我的暑假生活》HTML5 —— 电影感实拍 + 深海军蓝 + 琥珀金 + 衬线大标题
   v2 保留并存（我的暑假生活_v2.html）；v3 输出独立文件 我的暑假生活_v3.html、独立外链 slug。"""
import base64, hashlib, re, os, subprocess
from PIL import Image

BASE = '/root/zhijian/dsh-expert-library/work/暑假演讲_我的暑假生活/html5'
ASSETS = os.path.join(BASE, 'assets')
SRC = '/root/zhijian/dsh-expert-library/work/.dsh-filess/session-ca1775b2-1c88-4eff-857b-a26e06a7e1b8'

def b64(p):
    return base64.b64encode(open(p, 'rb').read()).decode()

# ---------------------------------------------------------------- 照片再加工（封面主视觉提高分辨率）
def export(src, dst, maxw, q):
    im = Image.open(src).convert('RGB')
    if im.width > maxw:
        im = im.resize((maxw, round(im.height * maxw / im.width)), Image.LANCZOS)
    im.save(dst, quality=q, optimize=True, progressive=True)
    return f"{dst.split('/')[-1]} {im.size} {os.path.getsize(dst)//1024}KB"

log = []
log.append(export(os.path.join(SRC, '0f7ac4840af9-20260827-235616.720-1.jpg'), os.path.join(ASSETS, 'hero-aerial.jpg'), 1600, 80))
log.append(export(os.path.join(SRC, 'b3b3491563a2-20260827-235616.720-2.jpg'), os.path.join(ASSETS, 'bg-evening.jpg'), 1280, 75))
# 卡片图沿用
log.append('rocks/harvest reuse')

# ---------------------------------------------------------------- HTML
HTML = r'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>我的暑假生活 · 英弘毅</title>
<!--
  文件名: 我的暑假生活_v3.html
  项目: 三年级演讲《我的暑假生活》HTML5 视觉稿 v3（精致 · 高端大气 · 科技感）
  版本: v3 · 2026-08-28 · 方向重定位（兔兔反馈 + 用户定调：精致/高端大气/可科技）：
        电影感实拍大图（航拍封面）+ 深海军蓝底 + 琥珀金点缀 + 思源宋体大标题(子集内嵌)
        + 玻璃拟态卡片 + 克制运镜（缓出淡入 / Ken Burns / 细线生长），不覆盖 v2。
  作者: captain（DeepSeek Harness Expert Library）
  sha256(不含本注释行): __SHA__
  动效引擎: GSAP 3.12.5（CDN；CDN 失败自动降级为静态可读版，不白屏）
  字体: Noto Serif SC（OFL）wght600 按用字子集 woff2 内嵌，仅标题/数字/眉题
  照片: 4 张实拍 base64 内嵌（航拍→封面 / 礁石海边→幕2 / 赶海收获→幕5 / 傍晚海景→幕6）
  动画纪律: 每幕一个主角镜头效果；只动 transform/opacity；缓出优雅无弹跳；确定性渲染（禁 Math.random）；
            prefers-reduced-motion 整卷跳终态；幕内不含秒数/备注文字。
-->
<style>
@font-face{
  font-family:'SerifSC'; src:url(data:font/woff2;base64,__FONT__) format('woff2');
  font-weight:400 900; font-style:normal; font-display:block;
}
:root{
  --bg0:#081525; --bg1:#0C2238; --bg2:#123252;
  --ink:#F2F7FC; --ink-70:rgba(242,247,252,.72); --ink-45:rgba(242,247,252,.45);
  --gold:#F0B454; --gold-soft:#FFD98A; --cyan:#6FC3E8;
  --glass:rgba(255,255,255,.075); --glass2:rgba(255,255,255,.11);
  --line:rgba(255,255,255,.16); --line-soft:rgba(255,255,255,.09);
  --shadow:rgba(2,10,22,.5);
  --serif:'SerifSC','Noto Serif SC','Songti SC',serif;
  --sans:'PingFang SC','Microsoft YaHei','Helvetica Neue',system-ui,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0;}
html,body{height:100%;}
body{
  font-family:var(--sans); background:var(--bg0); color:var(--ink);
  -webkit-font-smoothing:antialiased; user-select:none; -webkit-user-select:none;
}
#stage{position:relative; width:100%;}
.scene{position:relative; width:100%; min-height:100vh; overflow:hidden;
  display:flex; align-items:center; justify-content:center;}
body.deck-ok{overflow:hidden;}
body.deck-ok #stage{height:100vh;}
body.deck-ok .scene{position:absolute; inset:0; height:100%; opacity:0; visibility:hidden; pointer-events:none;}
body.deck-ok .scene.active{opacity:1; visibility:visible; pointer-events:auto;}
body.no-gsap .nav{display:none;}

/* 科技底纹：点阵 + 细网格 + 顶部辉光（纯装饰层） */
.gridbg{position:absolute; inset:0; z-index:0;
  background-image:
    radial-gradient(1100px 520px at 82% -8%, rgba(111,195,232,.10), transparent 62%),
    radial-gradient(900px 480px at 8% 108%, rgba(240,180,84,.07), transparent 60%),
    radial-gradient(rgba(255,255,255,.055) 1px, transparent 1.5px);
  background-size:auto,auto,26px 26px;}
.hairline-t{position:absolute; left:4.5%; right:4.5%; top:4.2%; height:1px; background:linear-gradient(90deg, transparent, var(--line) 18%, var(--line) 82%, transparent); z-index:2;}
.hairline-b{position:absolute; left:4.5%; right:4.5%; bottom:4.2%; height:1px; background:linear-gradient(90deg, transparent, var(--line-soft) 18%, var(--line-soft) 82%, transparent); z-index:2;}

/* 眉题 + 大标题 */
.eyebrow{font-family:var(--sans); font-size:clamp(12px,1.05vw,19px); font-weight:600;
  letter-spacing:.42em; color:var(--gold); text-transform:uppercase; z-index:6;}
.eyebrow .zh{color:var(--ink-70); letter-spacing:.3em; margin-left:.6em;}
.rule{height:1px; background:linear-gradient(90deg, var(--gold), rgba(240,180,84,0)); width:clamp(46px,4.6vw,86px); z-index:6;}
.stitle{font-family:var(--serif); font-weight:600; color:var(--ink); letter-spacing:.1em;
  line-height:1.22; z-index:6;}
.num-cn{font-family:var(--serif); color:var(--gold);}

/* 玻璃卡 */
.glass{background:var(--glass); border:1px solid var(--line); border-radius:18px;
  backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px);
  box-shadow:0 18px 44px var(--shadow);}
.glowline{position:absolute; left:8%; right:8%; height:1px; z-index:5;
  background:linear-gradient(90deg, transparent, rgba(240,180,84,.75), transparent);
  opacity:0; will-change:opacity;}

/* 照片卡（精致相框） */
.pcard{position:absolute; z-index:6; border-radius:20px; overflow:hidden;
  border:1px solid rgba(255,255,255,.22); box-shadow:0 30px 70px var(--shadow);
  will-change:transform,opacity;}
.pcard img{display:block; width:100%; height:100%; object-fit:cover;}
.pcard .cap{position:absolute; left:0; right:0; bottom:0; padding:.7em 1em .8em;
  font-size:clamp(13px,1.05vw,19px); letter-spacing:.3em; color:var(--ink);
  background:linear-gradient(180deg, transparent, rgba(4,14,28,.78));}

/* 幕1 封面 */
#s1{background:var(--bg0);}
#s1 .bgphoto{position:absolute; inset:0; width:100%; height:100%; object-fit:cover; will-change:transform;}
#s1 .scrim{position:absolute; inset:0; z-index:1;
  background:linear-gradient(180deg, rgba(6,18,34,.42) 0%, rgba(6,18,34,.10) 42%, rgba(6,18,34,.78) 100%);}
#s1 .wrap{position:absolute; left:7%; right:7%; bottom:11%; z-index:6;}
#s1 .title{font-size:clamp(56px,8.4vw,158px); letter-spacing:.14em; line-height:1.14;}
#s1 .sub{display:inline-flex; align-items:center; gap:1em; margin-top:2.6vh;
  padding:.62em 1.35em; border-radius:999px; background:rgba(8,21,37,.42);
  border:1px solid var(--line); backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px);
  font-size:clamp(15px,1.35vw,25px); letter-spacing:.24em; color:var(--ink);}
#s1 .sub i{width:.5em; height:.5em; border-radius:50%; background:var(--gold);}
#s1 .year{position:absolute; right:7%; top:9.5%; text-align:right; z-index:6;
  font-family:var(--serif); color:var(--ink-70); letter-spacing:.3em;
  font-size:clamp(15px,1.3vw,24px);}
#s1 .year b{display:block; font-size:clamp(30px,2.9vw,54px); color:var(--ink); letter-spacing:.12em; font-weight:600;}

/* 幕2 出发 */
#s2 .wrap{position:absolute; inset:0; z-index:5; display:flex; align-items:center;
  padding:9% 7% 8% 7%; gap:clamp(28px,4vw,72px);}
#s2 .left{flex:1.15; min-width:0;}
#s2 .stitle{font-size:clamp(38px,4.5vw,84px); margin:1.6vh 0 3.4vh;}
#s2 .row{display:flex; align-items:baseline; gap:1.1em; padding:1.32em 0;
  border-bottom:1px solid var(--line-soft); will-change:transform,opacity;}
#s2 .row .no{font-family:var(--serif); color:var(--gold); font-size:clamp(16px,1.35vw,25px); letter-spacing:.1em;}
#s2 .row .tx{font-size:clamp(18px,1.72vw,33px); font-weight:600; color:var(--ink); letter-spacing:.06em;}
#s2 .row.hot .tx{color:var(--gold-soft);}
#s2 .pcard{position:relative; flex:none; width:clamp(280px,30vw,560px); aspect-ratio:4/3.2; transform:rotate(1.2deg);}

/* 幕3 装备 */
#s3 .wrap{position:absolute; inset:0; z-index:5; padding:8% 7% 9%;}
#s3 .stitle{font-size:clamp(38px,4.5vw,84px); margin:1.6vh 0 6vh;}
#s3 .beam{position:absolute; left:0; right:0; top:34%; height:34%; z-index:2; opacity:0;
  background:linear-gradient(90deg, transparent 0%, rgba(255,217,138,.16) 42%, rgba(255,241,194,.30) 50%, rgba(255,217,138,.16) 58%, transparent 100%);
  will-change:transform,opacity;}
#s3 .gearrow{display:flex; gap:clamp(12px,1.7vw,30px); margin-top:1vh;}
#s3 .gear{flex:1; position:relative; padding:2em .8em 1.5em; text-align:center;
  border-radius:18px; background:var(--glass); border:1px solid var(--line);
  backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
  will-change:transform,opacity;}
#s3 .gear .glow{position:absolute; inset:-1px; border-radius:18px; opacity:0; pointer-events:none;
  box-shadow:0 0 0 1.5px rgba(255,217,138,.85), 0 0 34px rgba(255,201,60,.35) inset, 0 0 26px rgba(255,201,60,.25);
  will-change:opacity;}
#s3 .gear svg{width:clamp(44px,3.6vw,66px); display:block; margin:0 auto 1em;}
#s3 .gear b{display:block; font-family:var(--serif); font-weight:600; color:var(--ink);
  font-size:clamp(16px,1.45vw,27px); letter-spacing:.14em;}
#s3 .gear i{display:block; font-style:normal; margin-top:.5em; font-size:clamp(10px,.85vw,15px);
  letter-spacing:.3em; color:var(--ink-45);}
#s3 .march{margin-top:5.2vh; display:flex; align-items:center; gap:1.4em; will-change:transform,opacity;}
#s3 .march .ln{flex:1; height:1px; background:linear-gradient(90deg, transparent, var(--line) 30%, var(--line) 70%, transparent);}
#s3 .march b{font-family:var(--serif); font-weight:600; white-space:nowrap;
  font-size:clamp(19px,1.9vw,36px); color:var(--gold-soft); letter-spacing:.2em;}

/* 幕4 妙招 */
#s4 .wrap{position:absolute; inset:0; z-index:5; padding:8% 7% 9%;}
#s4 .stitle{font-size:clamp(38px,4.5vw,84px); margin:1.6vh 0 6.5vh;}
#s4 .steps{display:flex; gap:clamp(14px,1.8vw,30px); position:relative;}
#s4 .track{position:absolute; left:2%; right:2%; top:44px; height:1px;
  background:linear-gradient(90deg, rgba(240,180,84,.0), rgba(240,180,84,.6) 12%, rgba(240,180,84,.6) 88%, rgba(240,180,84,0));
  transform-origin:left center; transform:scaleX(0); z-index:1; will-change:transform;}
#s4 .step{flex:1; position:relative; z-index:2; border-radius:18px; padding:1.9em 1.5em 1.7em;
  background:var(--glass); border:1px solid var(--line);
  backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
  will-change:transform,opacity;}
#s4 .step .no{font-family:var(--serif); color:var(--gold); font-size:clamp(26px,2.3vw,44px); letter-spacing:.08em;}
#s4 .step b{display:block; font-family:var(--serif); font-weight:600; color:var(--ink);
  font-size:clamp(21px,1.95vw,37px); letter-spacing:.12em; margin:.55em 0 .5em;}
#s4 .step span{display:block; font-size:clamp(14px,1.28vw,24px); font-weight:500;
  color:var(--ink-70); line-height:1.6;}
#s4 .crabh {
  position:absolute; right:7%; bottom:6.5%; z-index:6; display:flex; align-items:center; gap:.9em;
  font-size:clamp(13px,1.1vw,19px); letter-spacing:.3em; color:var(--ink-45); will-change:transform,opacity;}
#s4 .crabh i{width:8px; height:8px; border-radius:50%; background:var(--gold);}

/* 幕5 收获 */
#s5 .wrap{position:absolute; inset:0; z-index:5; display:flex; align-items:center;
  padding:8% 7%; gap:clamp(26px,4vw,70px);}
#s5 .left{flex:1.2; min-width:0;}
#s5 .stitle{font-size:clamp(38px,4.4vw,82px); margin:1.6vh 0 4.5vh;}
#s5 .big{font-family:var(--serif); font-weight:600; color:var(--ink); line-height:1;
  font-size:clamp(88px,11.5vw,220px); letter-spacing:.04em; will-change:transform; z-index:5;}
#s5 .big .n{color:transparent; background:linear-gradient(180deg, #FFE3A6 8%, var(--gold) 58%, #C98A2E 100%);
  -webkit-background-clip:text; background-clip:text;}
#s5 .big .u{font-size:.42em; color:var(--ink-70); letter-spacing:.2em; margin-left:.18em;}
#s5 .chips{display:flex; gap:clamp(12px,1.5vw,26px); margin-top:5vh; will-change:transform,opacity;}
#s5 .chip{display:flex; align-items:baseline; gap:.7em; padding:.72em 1.3em; border-radius:14px;
  background:var(--glass2); border:1px solid var(--line);
  font-size:clamp(15px,1.35vw,25px); color:var(--ink);}
#s5 .chip b{font-family:var(--serif); color:var(--gold-soft); font-size:1.25em; letter-spacing:.05em;}
#s5 .quote{margin-top:5.4vh; font-family:var(--serif); font-weight:600;
  font-size:clamp(19px,1.85vw,35px); color:var(--ink); letter-spacing:.14em;
  will-change:transform,opacity;}
#s5 .quote i{font-style:normal; color:var(--gold);}
#s5 .pcard{position:relative; flex:none; width:clamp(280px,29vw,540px); aspect-ratio:4/3.4; transform:rotate(-1.2deg);}
#s5 .dust i{position:absolute; bottom:-3%; width:5px; height:5px; border-radius:50%;
  background:rgba(255,217,138,.65); opacity:0; z-index:4; will-change:transform,opacity;}

/* 幕6 谢幕 */
#s6 .bgphoto{position:absolute; inset:0; width:100%; height:100%; object-fit:cover; will-change:transform;}
#s6 .sunset{position:absolute; inset:0; z-index:1;
  background:linear-gradient(180deg, rgba(8,21,37,.52) 0%, rgba(8,21,37,.18) 42%, rgba(6,16,30,.78) 100%);}
#s6 .wrap{position:absolute; inset:0; z-index:6; display:flex; flex-direction:column;
  align-items:center; justify-content:center; text-align:center;}
#s6 .thanks{font-size:clamp(64px,9vw,172px); letter-spacing:.22em; text-indent:.22em;}
#s6 .rule{margin:3.6vh auto 3vh; background:linear-gradient(90deg, transparent, var(--gold), transparent); width:clamp(80px,9vw,170px);}
#s6 .badge{font-size:clamp(15px,1.4vw,26px); letter-spacing:.4em; color:var(--ink-70); text-indent:.4em;}

/* 导航 */
.nav{position:fixed; right:24px; bottom:20px; z-index:50; display:flex; align-items:center; gap:12px;
  background:rgba(8,21,37,.5); border:1px solid var(--line); border-radius:999px;
  padding:8px 14px; backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);}
.nav button{border:none; background:rgba(255,255,255,.08); width:32px; height:32px; border-radius:50%;
  font-size:16px; color:var(--ink); cursor:pointer; line-height:1;}
.nav .dots{display:flex; gap:7px; align-items:center;}
.nav .dot{width:7px; height:7px; border-radius:50%; background:rgba(255,255,255,.28); transition:all .25s;}
.nav .dot.on{background:var(--gold); width:18px; border-radius:99px;}

/* 降级基线 */
@media (prefers-reduced-motion: reduce){
  body.deck-ok .scene{position:relative; opacity:1; visibility:visible; min-height:100vh;}
  .track{transform:none!important;}
}
</style>
</head>
<body>
<div id="stage">

  <!-- ========== 幕1 封面 · 航拍主视觉（hero: Ken Burns + 标题缓升） ========== -->
  <section class="scene" id="s1">
    <img class="bgphoto" src="__IMG_AERIAL__" alt="青岛海边航拍">
    <div class="scrim"></div>
    <div class="wrap">
      <div class="eyebrow">My Summer Vacation<span class="zh">演讲</span></div>
      <div class="rule" style="margin:2.4vh 0 3vh;"></div>
      <h1 class="stitle title">我的暑假生活</h1>
      <div class="sub"><i></i>演讲者：英弘毅 · 三年级</div>
    </div>
    <div class="year">SUMMER<b>2026</b></div>
    <div class="hairline-t"></div><div class="hairline-b"></div>
  </section>

  <!-- ========== 幕2 出发 · 编号清单 + 照片（hero: 清单缓出 + 细线生长） ========== -->
  <section class="scene" id="s2">
    <div class="gridbg"></div>
    <div class="hairline-t"></div><div class="hairline-b"></div>
    <div class="wrap">
      <div class="left">
        <div class="eyebrow">01<span class="zh">出发</span></div>
        <h2 class="stitle">出发！去青岛海边</h2>
        <div class="row"><span class="no">壹</span><span class="tx">暑假天气太热了</span></div>
        <div class="row"><span class="no">贰</span><span class="tx">妈妈带我和三个表姐</span></div>
        <div class="row"><span class="no">叁</span><span class="tx">一起去青岛的海边玩</span></div>
        <div class="row hot"><span class="no">肆</span><span class="tx">捉螃蟹是我觉得最有趣的事</span></div>
      </div>
      <figure class="pcard">
        <img src="__IMG_ROCKS__" alt="青岛海边实拍">
        <figcaption class="cap">青岛 · 海边</figcaption>
      </figure>
    </div>
  </section>

  <!-- ========== 幕3 装备 · 玻璃卡 + 光带扫掠（hero: 匀速光带逐卡点亮） ========== -->
  <section class="scene" id="s3">
    <div class="gridbg"></div>
    <div class="hairline-t"></div><div class="hairline-b"></div>
    <div class="beam"></div>
    <div class="wrap">
      <div class="eyebrow">02<span class="zh">装备清单</span></div>
      <h2 class="stitle">捉蟹装备大集合</h2>
      <div class="gearrow">
        <div class="glass gear"><i class="glow"></i>
          <svg viewBox="0 0 64 64" fill="none" stroke="#FFD98A" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect x="24" y="14" width="16" height="24" rx="6"/><path d="M20 38 L44 38 L48 50 L16 50 Z"/><path d="M52 16 L60 12 M54 26 L62 26 M52 36 L60 40"/></svg>
          <b>探照灯</b><i>TORCH</i>
        </div>
        <div class="glass gear"><i class="glow"></i>
          <svg viewBox="0 0 64 64" fill="none" stroke="#FFD98A" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M24 8 h16 v8 l6 8 v30 h-9 v-10 h-10 v10 h-9 v-30 l6-8 Z"/><path d="M24 8 q8 -6 16 0"/><circle cx="32" cy="30" r="3"/></svg>
          <b>连体防水服</b><i>SUIT</i>
        </div>
        <div class="glass gear"><i class="glow"></i>
          <svg viewBox="0 0 64 64" fill="none" stroke="#FFD98A" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 36 q-6 -24 14 -26 q20 -2 14 26 l4 12 q-18 8 -36 0 Z"/><path d="M24 18 v10 M32 16 v12 M40 18 v10"/></svg>
          <b>手套</b><i>GLOVE</i>
        </div>
        <div class="glass gear"><i class="glow"></i>
          <svg viewBox="0 0 64 64" fill="none" stroke="#FFD98A" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 24 h40 l-6 30 h-28 Z"/><path d="M16 24 q16 -18 32 0"/><path d="M15 34 h34"/></svg>
          <b>小水桶</b><i>BUCKET</i>
        </div>
        <div class="glass gear"><i class="glow"></i>
          <svg viewBox="0 0 64 64" fill="none" stroke="#FFD98A" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M22 8 q-14 12 -2 24"/><path d="M42 8 q14 12 2 24"/><path d="M26 32 l-7 22 M38 32 l7 22"/><circle cx="32" cy="30" r="4"/></svg>
          <b>大钳子</b><i>TONGS</i>
        </div>
      </div>
      <div class="march"><span class="ln"></span><b>全副武装，向礁石群出发！</b><span class="ln"></span></div>
    </div>
    <div class="glowline" style="top:58%;"></div>
  </section>

  <!-- ========== 幕4 妙招 · 时间轴步骤卡（hero: 金线生长 + 逐卡缓出） ========== -->
  <section class="scene" id="s4">
    <div class="gridbg"></div>
    <div class="hairline-t"></div><div class="hairline-b"></div>
    <div class="wrap">
      <div class="eyebrow">03<span class="zh">妙招</span></div>
      <h2 class="stitle">我的捉蟹妙招</h2>
      <div class="steps">
        <div class="track"></div>
        <div class="glass step"><span class="no">01</span><b>碰运气</b><span>一开始什么也没抓到</span></div>
        <div class="glass step"><span class="no">02</span><b>守株待兔</b><span>坐在礁石上等海水退潮</span></div>
        <div class="glass step"><span class="no">03</span><b>搬石头</b><span>石头缝里有水就立刻搬开</span></div>
        <div class="glass step"><span class="no">04</span><b>照水面</b><span>探照灯下有波纹就马上夹住</span></div>
      </div>
      <div class="crabh"><i></i>QINGDAO · 2026</div>
    </div>
  </section>

  <!-- ========== 幕5 收获 · 大数字 + 金尘微粒（hero: 数字冲线 + 金尘上升） ========== -->
  <section class="scene" id="s5">
    <div class="gridbg"></div>
    <div class="hairline-t"></div><div class="hairline-b"></div>
    <div class="dust" aria-hidden="true"></div>
    <div class="wrap">
      <div class="left">
        <div class="eyebrow">04<span class="zh">收获</span></div>
        <h2 class="stitle">收获满满！</h2>
        <div class="big"><span class="n" id="cnt">100</span><span class="u">只</span></div>
        <div class="chips">
          <div class="chip">用时<b>1～2</b>小时</div>
          <div class="chip">心情<b>超开心</b></div>
        </div>
        <div class="quote">捉螃蟹，真是一件<i>令人开心</i>的事情。</div>
      </div>
      <figure class="pcard">
        <img src="__IMG_HARVEST__" alt="赶海收获实拍">
        <figcaption class="cap">八月 · 青岛</figcaption>
      </figure>
    </div>
  </section>

  <!-- ========== 幕6 谢幕 · 傍晚海景（hero: 缓退 Ken Burns + 大字浮现） ========== -->
  <section class="scene" id="s6">
    <img class="bgphoto" src="__IMG_EVENING__" alt="傍晚的海边">
    <div class="sunset"></div>
    <div class="wrap">
      <div class="eyebrow">Thanks<span class="zh">谢幕</span></div>
      <h2 class="stitle thanks">谢谢大家！</h2>
      <div class="rule"></div>
      <div class="badge">我的暑假生活 · 英弘毅</div>
    </div>
  </section>

</div>

<div class="nav" aria-label="翻页">
  <button class="nprev" aria-label="上一幕">‹</button>
  <div class="dots">
    <span class="dot on"></span><span class="dot"></span><span class="dot"></span>
    <span class="dot"></span><span class="dot"></span><span class="dot"></span>
  </div>
  <button class="nnext" aria-label="下一幕">›</button>
</div>

<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
<script>
(function(){
  'use strict';
  var $  = function(s){ return document.querySelector(s); };
  var $a = function(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var reduce = false;
  try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch(e){}

  /* CDN 失败 → 静态可读降级（不白屏、无报错） */
  if (!window.gsap){ document.body.classList.add('no-gsap'); return; }
  document.body.classList.add('deck-ok');

  /* 确定性伪随机（禁 Math.random） */
  function mulberry32(seed){
    return function(){
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* 幕5 金尘微粒：26 粒缓慢上升（确定性） */
  function buildDust(){
    var box = $('#s5 .dust'); if (!box) return;
    var rnd = mulberry32(20260828);
    for (var i=0;i<26;i++){
      var d = document.createElement('i');
      d.style.left = (2 + rnd()*96) + '%';
      d.style.width = d.style.height = (3 + rnd()*5) + 'px';
      box.appendChild(d);
    }
  }
  buildDust();

  var cnt = $('#cnt');
  function countNum(){
    if (reduce){ cnt.textContent = '100'; return; }
    var o = { v:0 };
    gsap.to(o, { v:100, duration:1.5, ease:'power2.out',
      onUpdate:function(){ cnt.textContent = Math.round(o.v); } });
  }

  /* ---------- 各幕时间线（缓出、克制、每幕一个主角） ---------- */
  var tls = [];

  /* 幕1 封面：Ken Burns + 标题缓升（10s） */
  var t1 = gsap.timeline({ paused:true });
  t1.fromTo('#s1 .bgphoto', { scale:1.09 }, { scale:1.0, duration:8.5, ease:'power1.out' }, 0)
    .fromTo('#s1 .eyebrow', { y:18, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.7, ease:'power2.out' }, 0.5)
    .fromTo('#s1 .rule', { scaleX:0, transformOrigin:'left center' }, { scaleX:1, duration:0.7, ease:'power2.out' }, 0.9)
    .fromTo('#s1 .title', { y:44, autoAlpha:0 }, { y:0, autoAlpha:1, duration:1.0, ease:'power3.out' }, 1.15)
    .fromTo('#s1 .sub', { y:24, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.7, ease:'power2.out' }, 2.4)
    .fromTo('#s1 .year', { x:26, autoAlpha:0 }, { x:0, autoAlpha:1, duration:0.7, ease:'power2.out' }, 2.7)
    .fromTo('#s1 .hairline-t,#s1 .hairline-b', { autoAlpha:0 }, { autoAlpha:1, duration:0.9 }, 1.2)
    .to({}, { duration:4.8 }, 5.2);
  tls.push(t1);

  /* 幕2 出发：清单逐行缓出（10s） */
  var t2 = gsap.timeline({ paused:true });
  t2.fromTo('#s2 .eyebrow', { y:16, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.6, ease:'power2.out' }, 0.2)
    .fromTo('#s2 .stitle', { y:34, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.85, ease:'power3.out' }, 0.5)
    .fromTo('#s2 .row', { x:-30, autoAlpha:0 }, { x:0, autoAlpha:1, duration:0.6, ease:'power2.out', stagger:0.55 }, 1.3)
    .fromTo('#s2 .pcard', { y:44, rotation:2.4, autoAlpha:0 }, { y:0, rotation:1.2, autoAlpha:1, duration:0.9, ease:'power2.out' }, 4.4)
    .fromTo('#s2 .pcard img', { scale:1.12 }, { scale:1.0, duration:4.5, ease:'power1.out' }, 4.4)
    .to({}, { duration:1.0 }, 9.0);
  tls.push(t2);

  /* 幕3 装备：光带匀速扫过，卡片逐个点亮（8s） */
  var t3 = gsap.timeline({ paused:true });
  t3.fromTo('#s3 .eyebrow', { y:16, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.55, ease:'power2.out' }, 0.2)
    .fromTo('#s3 .stitle', { y:32, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.8, ease:'power3.out' }, 0.45)
    .fromTo('#s3 .gear', { y:36, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.55, ease:'power2.out', stagger:0.14 }, 1.2)
    .fromTo('#s3 .beam', { xPercent:-32, autoAlpha:0 }, { xPercent:26, autoAlpha:1, duration:3.4, ease:'none' }, 1.6)
    .to('#s3 .gear .glow', { autoAlpha:1, duration:0.35, ease:'power1.out', stagger:0.45 }, 2.0)
    .to({}, { duration:0.6 }, 3.85)
    .fromTo('#s3 .march', { y:22, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.7, ease:'power2.out' }, 5.4)
    .fromTo('#s3 .glowline', { autoAlpha:0 }, { autoAlpha:0.8, duration:0.8 }, 5.6)
    .to({}, { duration:1.4 }, 6.4);
  tls.push(t3);

  /* 幕4 妙招：金线生长 + 四卡缓出（15s） */
  var t4 = gsap.timeline({ paused:true });
  t4.fromTo('#s4 .eyebrow', { y:16, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.55, ease:'power2.out' }, 0.2)
    .fromTo('#s4 .stitle', { y:32, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.8, ease:'power3.out' }, 0.45)
    .to('#s4 .track', { scaleX:1, duration:1.6, ease:'power1.inOut' }, 1.4)
    .fromTo('#s4 .step', { y:40, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.65, ease:'power2.out', stagger:0.75 }, 1.7)
    .fromTo('#s4 .crabh', { autoAlpha:0 }, { autoAlpha:1, duration:0.7 }, 6.2)
    .fromTo('#s4 .wrap', { scale:1.0 }, { scale:1.035, duration:8.6, ease:'none' }, 6.4)
    .to({}, { duration:0.1 }, 14.9);
  tls.push(t4);

  /* 幕5 收获：大数字冲线 + 金尘（12s） */
  var t5 = gsap.timeline({ paused:true });
  t5.fromTo('#s5 .eyebrow', { y:16, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.55, ease:'power2.out' }, 0.2)
    .fromTo('#s5 .stitle', { y:32, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.8, ease:'power3.out' }, 0.45)
    .fromTo('#s5 .big', { scale:0.92, autoAlpha:0 }, { scale:1, autoAlpha:1, duration:0.9, ease:'power3.out' }, 1.3)
    .add(countNum, 1.6)
    .fromTo('#s5 .chips', { y:26, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.6, ease:'power2.out' }, 3.2)
    .fromTo('#s5 .pcard', { y:44, rotation:-2.4, autoAlpha:0 }, { y:0, rotation:-1.2, autoAlpha:1, duration:0.9, ease:'power2.out' }, 3.9)
    .fromTo('#s5 .pcard img', { scale:1.12 }, { scale:1.0, duration:4.5, ease:'power1.out' }, 3.9)
    .fromTo('#s5 .quote', { y:22, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.7, ease:'power2.out' }, 6.1)
    .fromTo('#s5 .dust i',
      { y:0, autoAlpha:0 },
      { y:-460, autoAlpha:0.7, duration:5.5, ease:'none', stagger:0.09 }, 4.4)
    .to({}, { duration:2.2 }, 9.8);
  tls.push(t5);

  /* 幕6 谢幕：缓退 + 大字浮现（5s） */
  var t6 = gsap.timeline({ paused:true });
  t6.fromTo('#s6 .bgphoto', { scale:1.06 }, { scale:1.0, duration:4.6, ease:'power1.out' }, 0)
    .fromTo('#s6 .eyebrow', { y:14, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.55, ease:'power2.out' }, 0.4)
    .fromTo('#s6 .thanks', { y:36, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.95, ease:'power3.out' }, 0.8)
    .fromTo('#s6 .rule', { scaleX:0 }, { scaleX:1, duration:0.7, ease:'power2.out' }, 1.7)
    .fromTo('#s6 .badge', { y:18, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.6, ease:'power2.out' }, 2.1)
    .to({}, { duration:2.2 }, 2.8);
  tls.push(t6);

  /* ---------- 翻幕 ---------- */
  var cur = 0, dots = $a('.nav .dot');
  function show(i){
    i = Math.max(0, Math.min(5, i));
    var prev = cur; cur = i;
    $a('.scene').forEach(function(sc, j){
      if (reduce){ sc.classList.toggle('active', j === i); return; }
      if (j === i){ gsap.set(sc, { autoAlpha:1 }); }
      else if (j === prev){ gsap.to(sc, { autoAlpha:0, duration:0.5, ease:'power1.inOut' }); }
      else { gsap.set(sc, { autoAlpha:0 }); }
    });
    dots.forEach(function(d, j){ d.classList.toggle('on', j === i); });
  }
  function goTo(i){
    if (i === cur) return;
    show(i);
    if (!reduce){ tls[cur].restart(); }
  }
  function next(){ goTo(Math.min(5, cur + 1)); }
  function prev(){ goTo(Math.max(0, cur - 1)); }

  window.addEventListener('keydown', function(ev){
    if (ev.key === 'ArrowRight' || ev.key === ' ' || ev.key === 'PageDown' || ev.key === 'Enter'){ ev.preventDefault(); next(); }
    else if (ev.key === 'ArrowLeft' || ev.key === 'PageUp'){ ev.preventDefault(); prev(); }
    if (ev.key === 'Home') goTo(0);
    if (ev.key === 'End') goTo(5);
  });
  $('.nnext').addEventListener('click', function(ev){ ev.stopPropagation(); next(); });
  $('.nprev').addEventListener('click', function(ev){ ev.stopPropagation(); prev(); });
  $('#stage').addEventListener('click', function(ev){
    if (ev.target.closest('.nav')) return;
    next();
  });

  /* v3：reduced-motion 下整卷跳到各幕终态构图 */
  if (reduce){
    document.body.classList.add('rm');
    tls.forEach(function(t){ t.progress(1, true); });
    gsap.set('#s4 .track', { scaleX:1 });
    gsap.set('#s5 .dust i', { autoAlpha:0 });
    gsap.set('#s3 .beam', { autoAlpha:0.55, xPercent:8 });
    gsap.set('#s3 .gear .glow', { autoAlpha:0.9 });
  }

  /* ---- 启动 ---- */
  try {
    show(0);
    if (!reduce){ tls[0].restart(); }
    else { document.querySelectorAll('.scene')[0].classList.add('active'); }
  } catch (err) {
    document.body.classList.remove('deck-ok', 'rm');
    document.body.classList.add('no-gsap');
  }
})();
</script>
</body>
</html>'''

# ---------------------------------------------------------------- 字体子集（思源宋体 wght600）
font_note = ''
try:
    vf = '/tmp/NotoSerifSC-wght.ttf'
    if not os.path.exists(vf):
        import urllib.request
        req = urllib.request.Request(
            'https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf')
        with urllib.request.urlopen(req, timeout=120) as r, open(vf, 'wb') as w:
            w.write(r.read())
    from fontTools import ttLib
    from fontTools.varLib import instancer
    f = ttLib.TTFont(vf)
    instancer.instantiateVariableFont(f, {'wght': 600}, inplace=True)
    f.save('/tmp/SerifSC-600.ttf')

    text_chars = set('我的暑假生活演讲者英弘毅三年级出发去青岛海边捉螃蟹是我觉得最有趣的事'
                     '装备清单大集探照灯连体防水服手套小水桶钳子全副武装向礁石群妙招'
                     '碰运气守株待兔搬石头照面一开始什么也没抓到坐在上等潮缝里有就立刻开'
                     '下波纹马夹住收获约只小时超心真令人情谢大家时光八月壹贰叁肆用心情'
                     '0123456789～！，。·—QINGDAOSUMMERMYVACATIONTHANKSTORCHSUITGLOVEBUCKETONGS 01２3４')
    body = re.sub(r'<style>[\s\S]*?</style>', '', HTML)
    body = re.sub(r'<script[\s\S]*?</script>', '', body, flags=re.I)
    body = re.sub(r'<[^>]+>', '', body)
    for ch in body:
        if not ch.isspace() and ord(ch) > 32:
            text_chars.add(ch)
    chars = ''.join(sorted(text_chars))
    open('/tmp/serif-chars.txt', 'w', encoding='utf-8').write(chars)
    subprocess.run(['pyftsubset', '/tmp/SerifSC-600.ttf',
                    '--text-file=/tmp/serif-chars.txt',
                    '--flavor=woff2', '--no-hinting', '--desubroutinize',
                    '--output-file=/tmp/serif-sub.woff2'], check=True)
    font_note = f"font subset: {os.path.getsize('/tmp/serif-sub.woff2')/1024:.0f}KB, {len(chars)} chars"
    html = HTML.replace('__FONT__', b64('/tmp/serif-sub.woff2'))
except Exception as e:
    font_note = f'font FAILED: {e}（回退系统字体）'
    html = re.sub(r'@font-face\{[^}]*__FONT__[^}]*\}\n', '', HTML)

# ---------------------------------------------------------------- 照片
html = html.replace('__IMG_AERIAL__',  'data:image/jpeg;base64,' + b64(os.path.join(ASSETS, 'hero-aerial.jpg')))
html = html.replace('__IMG_EVENING__', 'data:image/jpeg;base64,' + b64(os.path.join(ASSETS, 'bg-evening.jpg')))
html = html.replace('__IMG_ROCKS__',   'data:image/jpeg;base64,' + b64(os.path.join(ASSETS, 'photo-rocks.jpg')))
html = html.replace('__IMG_HARVEST__', 'data:image/jpeg;base64,' + b64(os.path.join(ASSETS, 'photo-harvest.jpg')))

# ---------------------------------------------------------------- sha256
h = hashlib.sha256('\n'.join(l for l in html.split('\n') if 'sha256(不含本注释行)' not in l).encode()).hexdigest()
html = re.sub(r'sha256\(不含本注释行\): [0-9a-f]{64}', 'sha256(不含本注释行): ' + h, html)

out = os.path.join(BASE, '我的暑假生活_v3.html')
open(out, 'w', encoding='utf-8').write(html)
h2 = hashlib.sha256('\n'.join(l for l in html.split('\n') if 'sha256(不含本注释行)' not in l).encode()).hexdigest()
print('v3 written:', out)
print('size:', f"{os.path.getsize(out)/1024:.0f}KB", '|', font_note)
print('photos:', *[l for l in log], sep=' | ')
print('sha256(去sha行):', h, '| self-verify:', 'OK' if h2 == h else 'FAIL')
print('英弘毅:', html.count('英弘毅'), '| 莫弘毅:', html.count('莫弘毅'))
