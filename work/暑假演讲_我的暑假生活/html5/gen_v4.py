#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v4 生成器：「夏日画报」清新杂志编辑风《我的暑假生活》HTML5
   与 v2（手绘卡通）/ v3（暗色科技）完全不同的第三风格：
   米白纸面 + 墨蓝 + 珊瑚红 + 黑体大标题 + 杂志栅格 + 竖排标签 + 红印章。
   独立文件 我的暑假生活_v4.html；v2/v3 均保留。"""
import base64, hashlib, re, os, subprocess

BASE = '/root/zhijian/dsh-expert-library/work/暑假演讲_我的暑假生活/html5'
ASSETS = os.path.join(BASE, 'assets')

def b64(p):
    return base64.b64encode(open(p, 'rb').read()).decode()

HTML = r'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>我的暑假生活 · 英弘毅</title>
<!--
  文件名: 我的暑假生活_v4.html
  项目: 三年级演讲《我的暑假生活》HTML5 视觉稿 v4（夏日画报 · 清新杂志编辑风）
  版本: v4 · 2026-08-28 · 第三风格（v2 手绘卡通 / v3 暗色科技 之外完全不同方向）：
        米白纸面 #FAF6EE + 墨蓝 #16324A + 珊瑚红 #E8604C，黑体 900 大标题（思源黑体子集内嵌），
        杂志栅格 + 细墨线 + 图框注记（图一/图二）+ 竖排侧标签 + 红色印章动效。
  作者: captain（DeepSeek Harness Expert Library）
  sha256(不含本注释行): __SHA__
  动效引擎: GSAP 3.12.5（CDN；CDN 失败自动降级为静态可读版，不白屏）
  字体: Noto Sans SC（OFL）wght900 按用字子集 woff2 内嵌，仅标题/数字/刊头
  照片: 4 张实拍 base64 内嵌（航拍→封面图框 / 礁石海边→幕2 / 赶海收获→幕5 / 傍晚海景→幕6 封底）
  动画纪律: 每幕一个主角镜头效果；只动 transform/opacity（描线用 dashoffset）；缓出优雅；
            确定性渲染（禁 Math.random）；prefers-reduced-motion 整卷跳终态；幕内不含秒数/备注文字。
-->
<style>
@font-face{
  font-family:'SansSC'; src:url(data:font/woff2;base64,__FONT__) format('woff2');
  font-weight:100 900; font-style:normal; font-display:block;
}
:root{
  --paper:#FAF6EE; --paper2:#F3EDDF;
  --ink:#16324A; --ink70:rgba(22,50,74,.7); --ink45:rgba(22,50,74,.45); --ink14:rgba(22,50,74,.14);
  --coral:#E8604C; --teal:#1E9E8E; --sun:#F5B840; --sky:#BEE3F0;
  --serif:var(--sans);
  --sans:'SansSC','PingFang SC','Microsoft YaHei',system-ui,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0;}
html,body{height:100%;}
body{font-family:var(--sans); background:var(--paper); color:var(--ink);
  -webkit-font-smoothing:antialiased; user-select:none; -webkit-user-select:none;}
#stage{position:relative; width:100%;}
.scene{position:relative; width:100%; min-height:100vh; overflow:hidden;
  display:flex; align-items:center; justify-content:center;}
body.deck-ok{overflow:hidden;}
body.deck-ok #stage{height:100vh;}
body.deck-ok .scene{position:absolute; inset:0; height:100%; opacity:0; visibility:hidden; pointer-events:none;}
body.deck-ok .scene.active{opacity:1; visibility:visible; pointer-events:auto;}
body.no-gsap .nav{display:none;}

/* 杂志公共件 */
.rule2{height:2.5px; background:var(--ink); transform-origin:left center; will-change:transform;}
.rule1{height:1px; background:var(--ink14);}
.kicker{font-size:clamp(13px,1.05vw,19px); font-weight:800; letter-spacing:.42em; color:var(--coral);}
.kicker .en{color:var(--ink45); letter-spacing:.3em; margin-left:.8em; font-weight:700;}
.htitle{font-family:var(--sans); font-weight:900; color:var(--ink); letter-spacing:.06em; line-height:1.14;}
.frame{border:2.5px solid var(--ink); background:#fff; padding:10px;
  box-shadow:10px 12px 0 var(--ink14); will-change:transform,opacity;}
.frame .ph{display:block; width:100%; object-fit:cover;}
.frame figcaption{border-top:2px solid var(--ink); margin-top:10px; padding-top:8px;
  font-size:clamp(12px,1vw,18px); font-weight:800; letter-spacing:.24em; color:var(--ink);}
.frame figcaption i{font-style:normal; color:var(--coral); margin-right:.6em;}
.vlab{writing-mode:vertical-rl; letter-spacing:.5em; font-weight:900;
  font-size:clamp(14px,1.15vw,21px); color:var(--paper); background:var(--ink);
  padding:1.2em .55em; will-change:transform,opacity;}
.pagefoot{position:absolute; left:7%; right:7%; bottom:5.2%; z-index:6; display:flex;
  align-items:center; gap:1.2em; font-size:clamp(11px,.9vw,16px); font-weight:800;
  letter-spacing:.3em; color:var(--ink45);}
.pagefoot .ln{flex:1; height:1px; background:var(--ink14);}
.pagefoot b{color:var(--coral);}

/* 幕1 封面（杂志封面） */
#s1{background:var(--paper);}
#s1 .mast{position:absolute; left:7%; right:7%; top:5%; z-index:6;}
#s1 .mastrow{display:flex; justify-content:space-between; align-items:baseline; padding-bottom:.7em;}
#s1 .mast .name{font-weight:900; font-size:clamp(20px,1.8vw,34px); letter-spacing:.3em;}
#s1 .mast .name i{font-style:normal; color:var(--coral);}
#s1 .mast .meta{font-size:clamp(12px,1vw,18px); font-weight:800; letter-spacing:.28em; color:var(--ink70);}
#s1 .body{position:absolute; left:7%; right:7%; top:16%; bottom:12%; z-index:5;
  display:flex; gap:clamp(24px,3.2vw,60px); align-items:stretch;}
#s1 .leftcol{flex:1.15; display:flex; flex-direction:column; justify-content:center; min-width:0;}
#s1 .kick{margin-bottom:2.4vh;}
#s1 .tl{overflow:hidden;}
#s1 .tl > div{font-weight:900; font-size:clamp(58px,7.6vw,146px); line-height:1.16; letter-spacing:.08em; will-change:transform;}
#s1 .tl .hl{color:var(--coral);}
#s1 .sub{margin-top:3vh; font-size:clamp(16px,1.45vw,27px); font-weight:800; letter-spacing:.2em; color:var(--ink);}
#s1 .sub i{font-style:normal; color:var(--coral);}
#s1 .look{margin-top:2.6vh; font-size:clamp(13px,1.1vw,19px); font-weight:700; letter-spacing:.16em; color:var(--ink70); line-height:1.9;}
#s1 .look b{color:var(--ink); font-weight:900;}
#s1 .photo{flex:1; max-width:44%; display:flex; align-items:center;}
#s1 .photo .frame{width:100%;}
#s1 .photo img{height:clamp(240px,30vw,430px);}
#s1 .vwrap{display:flex; align-items:center; will-change:transform,opacity;}
#s1 .rules{position:absolute; left:7%; right:7%; top:calc(5% + 3.4em); z-index:6;}
#s1 .rule2.r1{width:100%;}
#s1 .rule2.r2{width:38%; margin-top:5px; background:var(--coral);}

/* 幕2 出发（专题页） */
#s2{background:linear-gradient(180deg,var(--paper) 0%, var(--paper2) 100%);}
#s2 .wrap{position:absolute; inset:0; padding:9% 7% 10%; display:flex; gap:clamp(26px,3.6vw,64px); z-index:5; align-items:center;}
#s2 .left{flex:1.2; min-width:0;}
#s2 .htitle{font-size:clamp(40px,4.6vw,88px); margin:2vh 0 4.5vh;}
#s2 .row{display:flex; align-items:baseline; gap:1.2em; padding:1.15em .2em; border-bottom:1px solid var(--ink14);
  will-change:transform,opacity;}
#s2 .row .no{font-weight:900; color:var(--ink45); font-size:clamp(15px,1.3vw,24px); letter-spacing:.2em;}
#s2 .row .tx{font-size:clamp(19px,1.8vw,34px); font-weight:800; letter-spacing:.05em;}
#s2 .row.hot .tx{color:var(--coral);}
#s2 .row.hot .no{color:var(--coral);}
#s2 .rightcol{flex:1; display:flex; gap:clamp(12px,1.4vw,24px); align-items:center; justify-content:flex-end;}
#s2 .photo{width:clamp(280px,26vw,500px);}
#s2 .photo img{height:clamp(230px,25vw,380px);}

/* 幕3 装备（清单页 + 印章） */
#s3{background:var(--paper);}
#s3 .wrap{position:absolute; inset:0; padding:8.5% 7% 10%; z-index:5;}
#s3 .htitle{font-size:clamp(40px,4.6vw,88px); margin:2vh 0 6vh;}
#s3 .list{display:flex; gap:clamp(12px,1.5vw,26px);}
#s3 .item{flex:1; border:2.5px solid var(--ink); background:#fff; padding:1.5em .8em 1.3em; text-align:center;
  position:relative; will-change:transform,opacity;}
#s3 .item .idx{position:absolute; left:10px; top:8px; font-weight:900; font-size:clamp(11px,.9vw,16px);
  letter-spacing:.2em; color:var(--ink45);}
#s3 .item svg{width:clamp(46px,3.8vw,70px); display:block; margin:0 auto 1em;}
#s3 .item b{display:block; font-weight:900; font-size:clamp(17px,1.55vw,29px); letter-spacing:.14em;}
#s3 .item i{display:block; font-style:normal; margin-top:.5em; font-size:clamp(10px,.85vw,15px);
  font-weight:800; letter-spacing:.3em; color:var(--ink45);}
#s3 .item .box{display:inline-block; margin-top:.9em; width:1.15em; height:1.15em; border:2.5px solid var(--ink); position:relative;}
#s3 .item .box svg{position:absolute; inset:-3px; width:calc(100% + 6px); height:calc(100% + 6px);}
#s3 .stamp{position:absolute; right:9%; top:16%; z-index:7; transform:rotate(-11deg); opacity:0;
  will-change:transform,opacity;}
#s3 .march{margin-top:6vh; display:flex; align-items:center; gap:1.3em;}
#s3 .march .ln{flex:1; height:2.5px; background:var(--ink); transform-origin:left center;}
#s3 .march b{font-weight:900; white-space:nowrap; font-size:clamp(20px,2vw,38px); letter-spacing:.18em;}
#s3 .march b i{font-style:normal; color:var(--coral);}

/* 幕4 妙招（四栏编号） */
#s4{background:linear-gradient(180deg,var(--paper2) 0%, var(--paper) 55%);}
#s4 .wrap{position:absolute; inset:0; padding:8.5% 7% 10%; z-index:5;}
#s4 .htitle{font-size:clamp(40px,4.6vw,88px); margin:2vh 0 7vh;}
#s4 .cols{display:flex; gap:clamp(16px,2vw,34px);}
#s4 .col{flex:1; border-top:6px solid var(--ink); padding-top:1.4em; will-change:transform,opacity;}
#s4 .col:nth-child(2) .num, #s4 .col:nth-child(4) .num{color:var(--coral);}
#s4 .col .num{font-weight:900; font-size:clamp(34px,3.1vw,60px); letter-spacing:.06em; line-height:1;}
#s4 .col b{display:block; font-weight:900; font-size:clamp(22px,2.05vw,39px); letter-spacing:.1em; margin:.55em 0 .5em;}
#s4 .col span{display:block; font-size:clamp(14px,1.3vw,25px); font-weight:600; color:var(--ink70); line-height:1.65;}
#s4 .col u{text-decoration:none; box-shadow:inset 0 -0.34em var(--sky); padding:0 .06em;}

/* 幕5 收获（大数字跨页） */
#s5{background:var(--paper);}
#s5 .wrap{position:absolute; inset:0; padding:8.5% 7% 10%; display:flex; gap:clamp(26px,3.6vw,64px); align-items:center; z-index:5;}
#s5 .left{flex:1.25; min-width:0;}
#s5 .htitle{font-size:clamp(40px,4.5vw,86px); margin:2vh 0 4vh;}
#s5 .big{font-weight:900; line-height:.95; letter-spacing:.02em; font-size:clamp(92px,11.5vw,222px); color:var(--ink); will-change:transform;}
#s5 .big .n{color:var(--coral);}
#s5 .big .u{font-size:.4em; letter-spacing:.2em; margin-left:.16em;}
#s5 .chips{display:flex; gap:clamp(12px,1.4vw,24px); margin-top:4.5vh;}
#s5 .chip{border:2.5px solid var(--ink); background:#fff; padding:.66em 1.25em;
  font-size:clamp(15px,1.35vw,25px); font-weight:800; letter-spacing:.1em; will-change:transform,opacity;}
#s5 .chip b{color:var(--teal); font-weight:900; margin:0 .2em;}
#s5 .quote{margin-top:5.2vh; display:flex; gap:.4em; will-change:transform,opacity;}
#s5 .quote .qm{font-weight:900; font-size:clamp(40px,3.6vw,70px); color:var(--coral); line-height:.9;}
#s5 .quote p{font-weight:900; font-size:clamp(20px,1.95vw,37px); letter-spacing:.1em; line-height:1.5;}
#s5 .quote p i{font-style:normal; color:var(--coral);}
#s5 .rightcol{flex:1; display:flex; gap:clamp(12px,1.4vw,24px); align-items:center; justify-content:flex-end;}
#s5 .photo{width:clamp(280px,25vw,480px);}
#s5 .photo img{height:clamp(240px,26vw,400px);}

/* 幕6 封底 */
#s6{background:var(--paper);}
#s6 .photohead{position:absolute; left:0; right:0; top:0; height:64%; overflow:hidden; border-bottom:3px solid var(--ink);}
#s6 .photohead img{width:100%; height:100%; object-fit:cover; will-change:transform;}
#s6 .photohead .tag{position:absolute; right:7%; bottom:4%; background:var(--paper);
  border:2px solid var(--ink); padding:.5em 1em; font-size:clamp(12px,1vw,18px); font-weight:800; letter-spacing:.28em;}
#s6 .band{position:absolute; left:0; right:0; bottom:0; height:36%; display:flex; flex-direction:column;
  align-items:center; justify-content:center; text-align:center;}
#s6 .thanks{font-weight:900; font-size:clamp(58px,7.6vw,146px); letter-spacing:.18em; text-indent:.18em; will-change:transform;}
#s6 .rule2{width:clamp(70px,7vw,130px); margin:2.6vh auto 2.2vh;}
#s6 .badge{font-size:clamp(15px,1.4vw,26px); font-weight:800; letter-spacing:.34em; text-indent:.34em;}
#s6 .colophon{margin-top:1.8vh; font-size:clamp(11px,.95vw,17px); font-weight:800; letter-spacing:.3em; color:var(--ink45);}

/* 导航（墨水风） */
.nav{position:fixed; right:24px; bottom:20px; z-index:50; display:flex; align-items:center; gap:11px;
  background:#fff; border:2px solid var(--ink); border-radius:999px; padding:8px 13px;
  box-shadow:5px 6px 0 var(--ink14);}
.nav button{border:none; background:var(--paper2); width:31px; height:31px; border-radius:50%;
  font-size:15px; color:var(--ink); cursor:pointer; line-height:1; font-weight:900;}
.nav .dots{display:flex; gap:6px; align-items:center;}
.nav .dot{width:8px; height:8px; border-radius:50%; background:var(--ink14); transition:all .25s;}
.nav .dot.on{background:var(--coral); width:17px; border-radius:99px;}

@media (prefers-reduced-motion: reduce){
  body.deck-ok .scene{position:relative; opacity:1; visibility:visible; min-height:100vh;}
}
</style>
</head>
<body>
<div id="stage">

  <!-- ========== 幕1 封面 · 杂志封面（hero: 标题逐行揭幕 + 图框呈现） ========== -->
  <section class="scene" id="s1">
    <div class="mast">
      <div class="mastrow">
        <div class="name">夏日画报<i>。</i>SUMMER JOURNAL</div>
        <div class="meta">第 1 期 · 2026 年夏 · 青岛特辑</div>
      </div>
    </div>
    <div class="rules">
      <div class="rule2 r1"></div>
      <div class="rule2 r2"></div>
    </div>
    <div class="body">
      <div class="leftcol">
        <div class="kicker kick">Cover Story<span class="en">封面故事 · 三年级暑期演讲</span></div>
        <div class="tl"><div>我的</div></div>
        <div class="tl"><div><span class="hl">暑假</span>生活</div></div>
        <div class="sub">演讲者：<i>英弘毅</i> · 三年级</div>
        <div class="look">本期看点 —— <b>捉蟹装备大集合</b> / <b>四大妙招</b> / <b>收获约100只</b></div>
      </div>
      <div class="photo">
        <figure class="frame">
          <img class="ph" src="__IMG_AERIAL__" alt="青岛海边航拍">
          <figcaption><i>图一</i>航拍 · 青岛的海</figcaption>
        </figure>
      </div>
      <div class="vwrap"><div class="vlab">英弘毅的夏天</div></div>
    </div>
    <div class="pagefoot"><span>我的暑假生活</span><span class="ln"></span><span><b>01</b> / 06</span></div>
  </section>

  <!-- ========== 幕2 出发 · 专题页（hero: 清单逐行缓出） ========== -->
  <section class="scene" id="s2">
    <div class="wrap">
      <div class="left">
        <div class="kicker">Feature<span class="en">栏目 · 出发</span></div>
        <h2 class="htitle">出发！去青岛海边</h2>
        <div class="row"><span class="no">壹</span><span class="tx">暑假天气太热了</span></div>
        <div class="row"><span class="no">贰</span><span class="tx">妈妈带我和三个表姐</span></div>
        <div class="row"><span class="no">叁</span><span class="tx">一起去青岛的海边玩</span></div>
        <div class="row hot"><span class="no">肆</span><span class="tx">捉螃蟹是我觉得最有趣的事</span></div>
      </div>
      <div class="rightcol">
        <figure class="frame photo">
          <img class="ph" src="__IMG_ROCKS__" alt="青岛海边实拍">
          <figcaption><i>图二</i>海边时光 · 礁石与浪</figcaption>
        </figure>
        <div class="vlab">No.01 出发</div>
      </div>
    </div>
    <div class="pagefoot"><span>夏日画报 · 封面故事</span><span class="ln"></span><span><b>02</b> / 06</span></div>
  </section>

  <!-- ========== 幕3 装备 · 清单页 + 红印章（hero: 打勾 + 章落） ========== -->
  <section class="scene" id="s3">
    <div class="wrap">
      <div class="kicker">Checklist<span class="en">栏目 · 装备清单</span></div>
      <h2 class="htitle">捉蟹装备大集合</h2>
      <div class="list">
        <div class="item"><span class="idx">NO.1</span>
          <svg viewBox="0 0 64 64" fill="none" stroke="var(--ink)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><rect x="24" y="14" width="16" height="24" rx="6"/><path d="M20 38 L44 38 L48 50 L16 50 Z"/><path d="M52 16 L60 12 M54 26 L62 26 M52 36 L60 40"/></svg>
          <b>探照灯</b><i>TORCH</i>
          <span class="box"><svg viewBox="0 0 24 24"><path class="chk" d="M5 13 L10 18 L19 6" fill="none" stroke="var(--coral)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        </div>
        <div class="item"><span class="idx">NO.2</span>
          <svg viewBox="0 0 64 64" fill="none" stroke="var(--ink)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M24 8 h16 v8 l6 8 v30 h-9 v-10 h-10 v10 h-9 v-30 l6-8 Z"/><path d="M24 8 q8 -6 16 0"/><circle cx="32" cy="30" r="3"/></svg>
          <b>连体防水服</b><i>SUIT</i>
          <span class="box"><svg viewBox="0 0 24 24"><path class="chk" d="M5 13 L10 18 L19 6" fill="none" stroke="var(--coral)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        </div>
        <div class="item"><span class="idx">NO.3</span>
          <svg viewBox="0 0 64 64" fill="none" stroke="var(--ink)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 36 q-6 -24 14 -26 q20 -2 14 26 l4 12 q-18 8 -36 0 Z"/><path d="M24 18 v10 M32 16 v12 M40 18 v10"/></svg>
          <b>手套</b><i>GLOVE</i>
          <span class="box"><svg viewBox="0 0 24 24"><path class="chk" d="M5 13 L10 18 L19 6" fill="none" stroke="var(--coral)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        </div>
        <div class="item"><span class="idx">NO.4</span>
          <svg viewBox="0 0 64 64" fill="none" stroke="var(--ink)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 24 h40 l-6 30 h-28 Z"/><path d="M16 24 q16 -18 32 0"/><path d="M15 34 h34"/></svg>
          <b>小水桶</b><i>BUCKET</i>
          <span class="box"><svg viewBox="0 0 24 24"><path class="chk" d="M5 13 L10 18 L19 6" fill="none" stroke="var(--coral)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        </div>
        <div class="item"><span class="idx">NO.5</span>
          <svg viewBox="0 0 64 64" fill="none" stroke="var(--ink)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 8 q-14 12 -2 24"/><path d="M42 8 q14 12 2 24"/><path d="M26 32 l-7 22 M38 32 l7 22"/><circle cx="32" cy="30" r="4"/></svg>
          <b>大钳子</b><i>TONGS</i>
          <span class="box"><svg viewBox="0 0 24 24"><path class="chk" d="M5 13 L10 18 L19 6" fill="none" stroke="var(--coral)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        </div>
      </div>
      <div class="march"><span class="ln"></span><b>全副武装<i>，</i>向礁石群出发！</b><span class="ln"></span></div>
    </div>
    <div class="stamp">
      <svg width="150" height="150" viewBox="0 0 150 150">
        <circle cx="75" cy="75" r="70" fill="none" stroke="var(--coral)" stroke-width="5"/>
        <circle cx="75" cy="75" r="56" fill="none" stroke="var(--coral)" stroke-width="2"/>
        <text x="75" y="66" text-anchor="middle" font-family="SansSC,PingFang SC,sans-serif" font-weight="900" font-size="27" fill="var(--coral)" letter-spacing="4">全副</text>
        <text x="75" y="100" text-anchor="middle" font-family="SansSC,PingFang SC,sans-serif" font-weight="900" font-size="27" fill="var(--coral)" letter-spacing="4">武装</text>
        <rect x="45" y="108" width="60" height="3" fill="var(--coral)"/>
      </svg>
    </div>
    <div class="pagefoot"><span>夏日画报 · 装备清单</span><span class="ln"></span><span><b>03</b> / 06</span></div>
  </section>

  <!-- ========== 幕4 妙招 · 四栏编号（hero: 粗线生长 + 栏目递进） ========== -->
  <section class="scene" id="s4">
    <div class="wrap">
      <div class="kicker">Method<span class="en">栏目 · 经验分享</span></div>
      <h2 class="htitle">我的捉蟹妙招</h2>
      <div class="cols">
        <div class="col"><div class="num">01</div><b>碰运气</b><span>一开始什么也没抓到</span></div>
        <div class="col"><div class="num">02</div><b>守株待兔</b><span>坐在礁石上<u>等海水退潮</u></span></div>
        <div class="col"><div class="num">03</div><b>搬石头</b><span>石头缝里有水就<u>立刻搬开</u></span></div>
        <div class="col"><div class="num">04</div><b>照水面</b><span>探照灯下有波纹就<u>马上夹住</u></span></div>
      </div>
    </div>
    <div class="pagefoot"><span>夏日画报 · 经验分享</span><span class="ln"></span><span><b>04</b> / 06</span></div>
  </section>

  <!-- ========== 幕5 收获 · 大数字跨页（hero: 数字冲线 + 引言块） ========== -->
  <section class="scene" id="s5">
    <div class="wrap">
      <div class="left">
        <div class="kicker">Harvest<span class="en">栏目 · 收获</span></div>
        <h2 class="htitle">收获满满！</h2>
        <div class="big"><span class="n" id="cnt">100</span><span class="u">只</span></div>
        <div class="chips">
          <div class="chip">用时<b>1～2</b>小时</div>
          <div class="chip">心情<b>超开心</b></div>
        </div>
        <div class="quote">
          <span class="qm">「</span>
          <p>捉螃蟹，真是一件<i>令人开心</i>的事情！<span class="qm">」</span></p>
        </div>
      </div>
      <div class="rightcol">
        <figure class="frame photo">
          <img class="ph" src="__IMG_HARVEST__" alt="赶海收获实拍">
          <figcaption><i>图三</i>八月青岛 · 我们的战利品</figcaption>
        </figure>
        <div class="vlab">No.04 收获</div>
      </div>
    </div>
    <div class="pagefoot"><span>夏日画报 · 收获</span><span class="ln"></span><span><b>05</b> / 06</span></div>
  </section>

  <!-- ========== 幕6 封底（hero: 图缓推 + 大字落定） ========== -->
  <section class="scene" id="s6">
    <div class="photohead">
      <img src="__IMG_EVENING__" alt="傍晚的海边">
      <div class="tag">图四 · 傍晚的海</div>
    </div>
    <div class="band">
      <div class="thanks">谢谢大家！</div>
      <div class="rule2"></div>
      <div class="badge">我的暑假生活 · 英弘毅</div>
      <div class="colophon">夏日画报 · 第 1 期 · 完 SUMMER JOURNAL</div>
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

  if (!window.gsap){ document.body.classList.add('no-gsap'); return; }
  document.body.classList.add('deck-ok');

  var cnt = $('#cnt');
  function countNum(){
    if (reduce){ cnt.textContent = '100'; return; }
    var o = { v:0 };
    gsap.to(o, { v:100, duration:1.4, ease:'power2.out',
      onUpdate:function(){ cnt.textContent = Math.round(o.v); } });
  }
  function drawChecks(){
    $a('#s3 .chk').forEach(function(c, i){
      var L = c.getTotalLength();
      if (reduce){ c.style.strokeDasharray = 'none'; c.style.strokeDashoffset = '0'; return; }
      c.style.strokeDasharray = L;
      c.style.strokeDashoffset = L;
      gsap.to(c, { strokeDashoffset:0, duration:0.3, ease:'power2.out', delay:i*0.22 });
    });
  }

  /* ---------- 各幕时间线 ---------- */
  var tls = [];

  /* 幕1 封面 10s */
  var t1 = gsap.timeline({ paused:true });
  t1.fromTo('#s1 .rule2', { scaleX:0 }, { scaleX:1, duration:0.8, ease:'power2.inOut', stagger:0.15 }, 0.2)
    .fromTo('#s1 .mastrow > *', { y:-16, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.6, ease:'power2.out', stagger:0.12 }, 0.3)
    .fromTo('#s1 .kick', { y:18, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.6, ease:'power2.out' }, 0.9)
    .fromTo('#s1 .tl > div', { yPercent:115 }, { yPercent:0, duration:0.85, ease:'power3.out', stagger:0.16 }, 1.1)
    .fromTo('#s1 .sub', { y:22, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.6, ease:'power2.out' }, 2.3)
    .fromTo('#s1 .look', { y:18, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.6, ease:'power2.out' }, 2.7)
    .fromTo('#s1 .photo .frame', { y:36, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.8, ease:'power2.out' }, 1.4)
    .fromTo('#s1 .photo img', { scale:1.07 }, { scale:1.0, duration:5.5, ease:'power1.out' }, 1.4)
    .fromTo('#s1 .vwrap', { x:30, autoAlpha:0 }, { x:0, autoAlpha:1, duration:0.6, ease:'power2.out' }, 3.1)
    .fromTo('#s1 .pagefoot', { autoAlpha:0 }, { autoAlpha:1, duration:0.6 }, 3.4)
    .to({}, { duration:5.4 }, 4.6);
  tls.push(t1);

  /* 幕2 出发 10s */
  var t2 = gsap.timeline({ paused:true });
  t2.fromTo('#s2 .kicker', { y:16, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.55, ease:'power2.out' }, 0.2)
    .fromTo('#s2 .htitle', { y:30, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.75, ease:'power3.out' }, 0.45)
    .fromTo('#s2 .row', { x:-28, autoAlpha:0 }, { x:0, autoAlpha:1, duration:0.55, ease:'power2.out', stagger:0.55 }, 1.2)
    .fromTo('#s2 .photo', { y:34, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.85, ease:'power2.out' }, 4.3)
    .fromTo('#s2 .photo img', { scale:1.08 }, { scale:1.0, duration:4.5, ease:'power1.out' }, 4.3)
    .fromTo('#s2 .vlab', { x:22, autoAlpha:0 }, { x:0, autoAlpha:1, duration:0.55, ease:'power2.out' }, 5.0)
    .fromTo('#s2 .pagefoot', { autoAlpha:0 }, { autoAlpha:1, duration:0.5 }, 1.0)
    .to({}, { duration:0.9 }, 9.1);
  tls.push(t2);

  /* 幕3 装备 8s（hero: 打勾 + 印章） */
  var t3 = gsap.timeline({ paused:true });
  t3.fromTo('#s3 .kicker', { y:16, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.5, ease:'power2.out' }, 0.2)
    .fromTo('#s3 .htitle', { y:28, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.7, ease:'power3.out' }, 0.4)
    .fromTo('#s3 .item', { y:34, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.5, ease:'power2.out', stagger:0.15 }, 1.0)
    .add(drawChecks, 2.3)
    .fromTo('#s3 .stamp', { scale:1.8, autoAlpha:0, rotation:2 },
            { scale:1, autoAlpha:0.94, rotation:-11, duration:0.3, ease:'power3.in' }, 5.2)
    .to('#s3 .stamp', { scale:1.04, duration:0.14, ease:'power1.out' }, 5.5)
    .to('#s3 .stamp', { scale:1, duration:0.12 }, 5.64)
    .fromTo('#s3 .march .ln', { scaleX:0 }, { scaleX:1, duration:0.6, ease:'power2.inOut', stagger:0.1 }, 5.8)
    .fromTo('#s3 .march b', { y:16, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.5, ease:'power2.out' }, 5.9)
    .to({}, { duration:1.2 }, 6.6);
  tls.push(t3);

  /* 幕4 妙招 15s */
  var t4 = gsap.timeline({ paused:true });
  t4.fromTo('#s4 .kicker', { y:16, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.5, ease:'power2.out' }, 0.2)
    .fromTo('#s4 .htitle', { y:28, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.7, ease:'power3.out' }, 0.45)
    .fromTo('#s4 .col', { y:34, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.6, ease:'power2.out', stagger:0.7 }, 1.2)
    .fromTo('#s4 .pagefoot', { autoAlpha:0 }, { autoAlpha:1, duration:0.5 }, 1.2)
    .fromTo('#s4 .wrap', { scale:1 }, { scale:1.035, duration:8.4, ease:'none' }, 6.2)
    .to({}, { duration:0.4 }, 14.7);
  tls.push(t4);

  /* 幕5 收获 12s */
  var t5 = gsap.timeline({ paused:true });
  t5.fromTo('#s5 .kicker', { y:16, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.5, ease:'power2.out' }, 0.2)
    .fromTo('#s5 .htitle', { y:28, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.7, ease:'power3.out' }, 0.45)
    .fromTo('#s5 .big', { scale:0.94, autoAlpha:0 }, { scale:1, autoAlpha:1, duration:0.8, ease:'power3.out' }, 1.2)
    .add(countNum, 1.5)
    .fromTo('#s5 .chip', { y:24, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.5, ease:'power2.out', stagger:0.2 }, 3.0)
    .fromTo('#s5 .photo', { y:34, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.8, ease:'power2.out' }, 3.8)
    .fromTo('#s5 .photo img', { scale:1.08 }, { scale:1.0, duration:4.2, ease:'power1.out' }, 3.8)
    .fromTo('#s5 .vlab', { x:22, autoAlpha:0 }, { x:0, autoAlpha:1, duration:0.5, ease:'power2.out' }, 4.4)
    .fromTo('#s5 .quote', { y:22, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.65, ease:'power2.out' }, 6.0)
    .fromTo('#s5 .pagefoot', { autoAlpha:0 }, { autoAlpha:1, duration:0.5 }, 1.0)
    .to({}, { duration:5.2 }, 6.8);
  tls.push(t5);

  /* 幕6 封底 5s */
  var t6 = gsap.timeline({ paused:true });
  t6.fromTo('#s6 .photohead img', { scale:1.07 }, { scale:1.0, duration:4.4, ease:'power1.out' }, 0)
    .fromTo('#s6 .tag', { y:14, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.5, ease:'power2.out' }, 0.6)
    .fromTo('#s6 .thanks', { y:30, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.8, ease:'power3.out' }, 0.9)
    .fromTo('#s6 .rule2', { scaleX:0 }, { scaleX:1, duration:0.6, ease:'power2.out' }, 1.7)
    .fromTo('#s6 .badge', { y:16, autoAlpha:0 }, { y:0, autoAlpha:1, duration:0.5, ease:'power2.out' }, 2.0)
    .fromTo('#s6 .colophon', { autoAlpha:0 }, { autoAlpha:1, duration:0.5 }, 2.4)
    .to({}, { duration:2.1 }, 2.9);
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

  /* v4：reduced-motion 下整卷跳终态 */
  if (reduce){
    document.body.classList.add('rm');
    tls.forEach(function(t){ t.progress(1, true); });
    $a('#s3 .chk').forEach(function(c){ c.style.strokeDasharray='none'; c.style.strokeDashoffset='0'; });
    gsap.set('#s3 .stamp', { autoAlpha:0.94, rotation:-11, scale:1 });
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

# ---------------------------------------------------------------- 字体子集（思源黑体 wght900）
font_note = ''
try:
    vf = '/tmp/NotoSansSC-wght.ttf'
    if not os.path.exists(vf):
        import urllib.request
        req = urllib.request.Request(
            'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf')
        with urllib.request.urlopen(req, timeout=120) as r, open(vf, 'wb') as w:
            w.write(r.read())
    from fontTools import ttLib
    from fontTools.varLib import instancer
    f = ttLib.TTFont(vf)
    instancer.instantiateVariableFont(f, {'wght': 900}, inplace=True)
    f.save('/tmp/SansSC-900.ttf')

    text_chars = set('我的暑假生活夏日画报第期年青岛特辑封面故事三年级暑期演讲者英弘毅'
                     '出发去海边捉蟹装备大集合全副武装向礁石群妙招收获约只小时超开心真令人情谢大家'
                     '时光八月我们的战利品完航拍的海傍晚栏目经验分享清单杂志社SUMMERJOURNALCOVERSTORY'
                     'FEATURECHECKLISTMETHODHARVESTFINNO'
                     '壹贰叁肆0123456789～！，。·—「」/ ')
    body = re.sub(r'<style>[\s\S]*?</style>', '', HTML)
    body = re.sub(r'<script[\s\S]*?</script>', '', body, flags=re.I)
    body = re.sub(r'<[^>]+>', '', body)
    for ch in body:
        if not ch.isspace() and ord(ch) > 32:
            text_chars.add(ch)
    chars = ''.join(sorted(text_chars))
    open('/tmp/sans-chars.txt', 'w', encoding='utf-8').write(chars)
    subprocess.run(['pyftsubset', '/tmp/SansSC-900.ttf',
                    '--text-file=/tmp/sans-chars.txt',
                    '--flavor=woff2', '--no-hinting', '--desubroutinize',
                    '--output-file=/tmp/sans-sub.woff2'], check=True)
    font_note = f"font subset: {os.path.getsize('/tmp/sans-sub.woff2')/1024:.0f}KB, {len(chars)} chars"
    html = HTML.replace('__FONT__', b64('/tmp/sans-sub.woff2'))
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

out = os.path.join(BASE, '我的暑假生活_v4.html')
open(out, 'w', encoding='utf-8').write(html)
h2 = hashlib.sha256('\n'.join(l for l in html.split('\n') if 'sha256(不含本注释行)' not in l).encode()).hexdigest()
print('v4 written:', out)
print('size:', f"{os.path.getsize(out)/1024:.0f}KB", '|', font_note)
print('sha256(去sha行):', h, '| self-verify:', 'OK' if h2 == h else 'FAIL')
print('英弘毅:', html.count('英弘毅'), '| 莫弘毅:', html.count('莫弘毅'))
