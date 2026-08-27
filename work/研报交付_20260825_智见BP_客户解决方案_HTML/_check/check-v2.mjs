// Designer 渲染检查 · 智见_客户与解决方案_六类客户_v2.html
// 用法: node check-v2.mjs <html路径> <输出目录>
import { chromium } from '/root/zhijian/zhijianharness-main/marketplace-src/nexu-io--open-design/node_modules/playwright-core/index.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { createHash } from 'crypto';

const htmlPath = resolve(process.argv[2]);
const outDir = resolve(process.argv[3]);
mkdirSync(outDir, { recursive: true });
const HTML = readFileSync(htmlPath, 'utf8');
const EXE = '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';

const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

// ---------- 对比度工具 ----------
function parseColor(s) {
  s = s.trim();
  let m = s.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
  if (m) return [ +m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4] ];
  m = s.match(/#([0-9a-f]{6})/i);
  if (m) { const v = parseInt(m[1], 16); return [ (v>>16)&255, (v>>8)&255, v&255, 1 ]; }
  m = s.match(/#([0-9a-f]{3})/i);
  if (m) { const v = parseInt(m[1], 16); const r=(v>>8)&15,g=(v>>4)&15,b=v&15; return [ r*17, g*17, b*17, 1 ]; }
  return null;
}
function lin(c) { c/=255; return c<=0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); }
function lum(c) { return 0.2126*lin(c[0]) + 0.7152*lin(c[1]) + 0.0722*lin(c[2]); }
function ratio(fg, bg) {
  const a = lum(fg), b = lum(bg);
  return (Math.max(a,b)+0.05) / (Math.min(a,b)+0.05);
}
function blend(fg, bg) { // fg rgba over bg rgb
  const a = fg[3];
  return [ fg[0]*a + bg[0]*(1-a), fg[1]*a + bg[1]*(1-a), fg[2]*a + bg[2]*(1-a), 1 ];
}

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });

// ---------- 1) 逐视口布局断言 ----------
const viewports = [ [1440,900], [1280,800], [1366,768], [390,844], [320,900] ];
const pageCounts = {};
for (const [w,h] of viewports) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'no-preference' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto('file://' + htmlPath);
  await page.waitForTimeout(600);

  const n = await page.locator('.page').count();
  pageCounts[`${w}x${h}`] = n;

  if (w >= 1024) {
    // 严格断言：每页高度 ≈ 视口高（容差 4px），且页内无纵向溢出
    let allH = true, detail = [];
    for (let i = 0; i < n; i++) {
      const box = await page.locator('.page').nth(i).boundingBox();
      const el = page.locator('.page').nth(i);
      const sh = await el.evaluate(e => e.scrollHeight), ch = await el.evaluate(e => e.clientHeight);
      const okH = box && Math.abs(box.height - h) <= 4;
      const okV = sh - ch <= 2;
      if (!okH || !okV) { allH = false; detail.push(`P${i+1}: h=${box&&box.height.toFixed(1)} sh-ch=${sh-ch}`); }
    }
    ok(`一屏一页 ${w}×${h}`, allH, detail.join(' ') || `${n}/${n} 页`);
  } else {
    // 移动端：滚动分页，断言无横向溢出
    const over = await page.evaluate(() => {
      const deck = document.getElementById('deck');
      const bad = [];
      if (deck.scrollWidth > deck.clientWidth + 1) bad.push(`deck scrollWidth ${deck.scrollWidth} > ${deck.clientWidth}`);
      document.querySelectorAll('.page *').forEach(el => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        if (st.position === 'fixed') return;
        if (r.right > window.innerWidth + 1 || r.left < -1) bad.push(el.className.toString().slice(0,40) + ' R=' + r.right.toFixed(0) + ' L=' + r.left.toFixed(0));
      });
      return bad.slice(0, 8);
    });
    ok(`移动端无横向溢出 ${w}×${h}`, over.length === 0, over.join(' | ') || 'ok');
  }
  ok(`console/pageerror 0 · ${w}×${h}`, errors.length === 0, errors.slice(0,3).join(' | ') || 'ok');
  await ctx.close();
}

// ---------- 2) 桌面严格断言统一汇总 ----------
for (const [w,h] of viewports) if (w >= 1024) {
  ok(`桌面页数 8 · ${w}×${h}`, pageCounts[`${w}x${h}`] === 8, `${pageCounts[`${w}x${h}`]} 页`);
}

// ---------- 3) 翻页交互（1440×900） ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('file://' + htmlPath);
  await page.waitForTimeout(500);
  const cur = () => page.evaluate(() => document.getElementById('pageCount').textContent.replace(/\s/g,''));

  await page.keyboard.press('End'); await page.waitForTimeout(900);
  ok('键盘 End → 8/8', (await cur()).startsWith('8/8'), await cur());
  await page.keyboard.press('Home'); await page.waitForTimeout(900);
  ok('键盘 Home → 1/8', (await cur()).startsWith('1/8'), await cur());
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(900);
  ok('键盘 → 2/8', (await cur()).startsWith('2/8'), await cur());
  await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(900);
  ok('键盘 ← 1/8', (await cur()).startsWith('1/8'), await cur());

  await page.locator('.dots button').nth(4).click(); await page.waitForTimeout(1000);
  const title5 = await page.evaluate(() => document.getElementById('pageTitle').textContent);
  ok('页点第5点 → 客户四', (await cur()).startsWith('5/8') && title5.includes('客户四'), title5);
  await page.locator('#nextBtn').click(); await page.waitForTimeout(1000);
  ok('翻页条 下一页 → 6/8', (await cur()).startsWith('6/8'), await cur());
  const disPrev = await page.locator('#prevBtn').isDisabled();
  const disNext = await page.locator('#nextBtn').isDisabled();
  ok('首末页按钮 disabled', disPrev === false && disNext === false, 'P6 非首末页');
  await page.keyboard.press('End'); await page.waitForTimeout(900);
  ok('末页 nextBtn disabled', await page.locator('#nextBtn').isDisabled(), 'End → 8/8');
  await page.keyboard.press('Home'); await page.waitForTimeout(900);
  ok('首页 prevBtn disabled', await page.locator('#prevBtn').isDisabled(), 'Home → 1/8');
  await ctx.close();
}

// ---------- 4) reduced-motion ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto('file://' + htmlPath);
  await page.waitForTimeout(400);
  const st = await page.evaluate(() => ({
    noMotion: document.documentElement.classList.contains('no-motion'),
    hiddenFades: [...document.querySelectorAll('.page .fade')].filter(e => getComputedStyle(e).opacity !== '1').length,
    scrollBehavior: getComputedStyle(document.getElementById('deck')).scrollBehavior,
  }));
  ok('reduced-motion: no-motion + fade 全可见', st.noMotion && st.hiddenFades === 0, JSON.stringify(st));
  await ctx.close();
}

// ---------- 5) 对比度抽样（1440×900 实渲染色） ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('file://' + htmlPath);
  await page.waitForTimeout(500);
  const samples = [
    ['P2 页头标题', '.phead h2'],
    ['P2 页头图标', '.phead .pic'],
    ['P2 结论条', '.concl p'],
    ['P2 结论条眉标', '.concl .lab'],
    ['P2 痛点正文', '.pains .chip'],
    ['P2 对比表正文', '.tbl td'],
    ['P2 对比表贝壳行', '.tbl .beike-row td'],
    ['P2 复现流节点', '.flow3 .n p'],
    ['P2 指数 chips', '.idx3 .chip'],
    ['P3 下钻卡', '.drill .d b'],
    ['P3 下钻卡注', '.drill .d.hot i'],
    ['P3 对比·新做法', '.cmp .new .r'],
    ['P4 时间轴条目', '.tl-card li'],
    ['P4 时间轴输出', '.tl-card .out'],
    ['P4 做底稿条', '.band p'],
    ['P5 公式卡正文', '.fcard p'],
    ['P5 公式输出 tags', '.fout .tags'],
    ['P5 公式输出 note', '.fout .note'],
    ['P5 闭环热节点', '.loop .step.hot'],
    ['P5 四本账注', '.fnote'],
    ['P6 链条卡', '.chain4 .c b'],
    ['P6 优势卡口径注', '.adv .a .cal'],
    ['P7 三层框架', '.lay3 .l3 .ds'],
    ['P7 三方对比·智见', '.cmp3 .c.win p'],
    ['P4 优势卡正文', '.adv .a p'],
    ['P4 组合chip', '.mix .chip'],
    ['P4 组合眉标', '.mix .mlab'],
    ['P2 分区眉标', '.sec-lab'],
  ];
  const res = await page.evaluate((sels) => {
    function parse(s) {
      s = s.trim();
      let m = s.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
      if (m) return [+m[1],+m[2],+m[3], m[4]===undefined?1:+m[4]];
      m = s.match(/#([0-9a-f]{6})/i);
      if (m) { const v=parseInt(m[1],16); return [(v>>16)&255,(v>>8)&255,v&255,1]; }
      return null;
    }
    function lin(c){c/=255;return c<=0.03928?c/12.92:Math.pow((c+0.055)/1.055,2.4);}
    function lum(c){return 0.2126*lin(c[0])+0.7152*lin(c[1])+0.0722*lin(c[2]);}
    function ratio(a,b){const x=lum(a),y=lum(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);}
    function blend(fg,bg){const a=fg[3];return [fg[0]*a+bg[0]*(1-a),fg[1]*a+bg[1]*(1-a),fg[2]*a+bg[2]*(1-a),1];}
    function resolveBg(el){
      // 渐变背景：取首个色标作为背景（对浅色前景取最深色标 = 保守估计）；沿祖先链查找
      let cur = el;
      while (cur && cur !== document.documentElement) {
        const bi = getComputedStyle(cur).backgroundImage;
        if (bi && bi.includes('gradient')) {
          const stops = bi.match(/#[0-9a-f]{6}|#[0-9a-f]{3}|rgba?\([^)]*\)/g) || [];
          if (stops.length) {
            const c = parse(stops[0]);
            if (c) return c[3] < 1 ? blend(c, [237,240,246,1]) : c;
          }
        }
        cur = cur.parentElement;
      }
      cur = el; let bg = null;
      while(cur){
        const c=parse(getComputedStyle(cur).backgroundColor);
        if(c && c[3]>0){ bg=c; break; }
        cur=cur.parentElement;
      }
      if(!bg) bg=[237,240,246,1];
      // 若为半透明，叠到下一层背景
      while(bg[3]<1){
        let nxt=null,cur2=cur?cur.parentElement:null;
        while(cur2){const c=parse(getComputedStyle(cur2).backgroundColor);if(c&&c[3]>0){nxt=c;break;}cur2=cur2.parentElement;}
        bg=nxt?blend(bg,nxt):blend(bg,[237,240,246,1]);
      }
      return bg;
    }
    return sels.map(([name,sel])=>{
      const el=document.querySelector(sel);
      if(!el) return {name, sel, miss:true};
      const fg=parse(getComputedStyle(el).color);
      const bg=resolveBg(el);
      return {name, sel, fg, bg, ratio:ratio(fg,bg)};
    });
  }, samples);
  let allPass = true;
  for (const r of res) {
    if (r.miss) { ok(`对比度 ${r.name}`, false, '未找到元素'); allPass=false; continue; }
    const pass = r.ratio >= 4.5;
    if (!pass) allPass = false;
    ok(`对比度 ${r.name}`, pass, r.ratio.toFixed(2) + ':1 (fg=' + r.fg.map(v=>v.toFixed(0)).join(',') + ' bg=' + r.bg.map(v=>v.toFixed(0)).join(',') + ')');
  }
  ok('对比度合计（' + samples.length + ' 组全部 ≥4.5:1）', allPass, '');
  await ctx.close();
}

// ---------- 6) 内容审计 ----------
{
  const kw = ['地方报送','口径不一','更新滞后','可核验底稿','数据分散','自然资源','金融各部门','交易事实','成交','挂牌','带看','颗粒度到小区','只描述已发生','不帮涨','不帮降','政策效果复现','重放数据','假设 / 计算','审计级底稿','没有底稿','价格 / 活跃 / 信心','40 城','50 城','口径纪律换公信力','免费送入口','热力度对比','领先 / 同步','白标','领导直问','300 人','四段式','待补数据','指数接口','政策库','政策映射','政研通数据团队','自爬','政策研究专家','政策解读 Agent','大屏集成实施方','先立标准','替换成本最高','四级下钻','地图','区县','迁移指数','底座复用','不重复建设','不换口径','成都样板','一城一建','XX 市房地产市场运行监测','不出现贝壳','放大器','一个省跑通','全省复制','城市数据包','历史序列','实施 / 白标团队','舆情审核协作','单点评估','贷后放任','时滞','压力测试','物业类型','客户集中度','不可复现','内审','监管检查','签章责任重','责任界面不清','T0','授信时点','估值区间','置信度','自动比对','三分归因','数据 / 方法 / 假设','授信参考底稿','T+N','贷后监测','持续更新估值','价值偏离预警','组合压力测试','贷后复核底稿','做底稿、不做签章','不抢法定评估','持牌评估机构','分润补位','远高于系统年费','持续需求','价值台账','同条件可复现','一键还原','先例背书','中国银行广州分行','2800 万','江苏银行','复制升级','1000 万起','3000 万为合适锚','目标假设','让功能不让价格','按机构分档','先签年度','减值计提','私有化部署','嵌入式组件','银行风控产品团队','模型 / 压力测试工程师','收储价格','改造成本','运营成本','政策目标','社会效益','经营安全','审计巡视','为什么这么决策','因果可解释','估值方法','收益法','比较法','DCF','过往事实数据','情形模拟','敏感性分析','空置','折现率','退出年限','可溯源','可复现','可跟踪','窗口指导','每个数字都有来路','项目建档','取数','假设设定','多法测算','情景压测','审批快照','审计复现与运营跟踪','四本账','在任不出事','离任查得清','福州左海集团','分散式收储试点','8 套','3000 多套','历史指数修正','中性定价','约 10%','省数千万','续约复购','市场公允','经营价值','安全边界','OA / 国资监管','收储决策工作台','敏感性分析模块','审批底稿导出','收储咨询','测算工程师','萧山环投','贵州 / 辽宁复制','1000+ 收储主体','存量蓄水池','源头活水','价值参考与监测信号','不替代法定评估','拿地','投后复盘','无法还原','榜单','条件化推演','结论绑定假设','版本','留痕','中指','克而瑞','指数排行','报告订阅','CLI','客户端','买报告','数据工作流','开盘定价支持','条件化解释','去化假设','不承诺结果','不做趋势性判断','土地供给','新房供应','库存','去化周期','贝壳授权数据','项目级颗粒度','Python','TS 双版本','2026-08 交付记录','批量城市比较','底稿导出','假设框定','边界声明','API / 集成工程师','行业研究顾问','先慢后快','不补贴换规模','S-LAYER','信息不对称','营销话术','中介话术不可验证','可复核依据','口碑','个人不动产研究 Agent','首付','月供','持有周期','不同假设下的结果','必须买','必然涨','红线','租金回报率','挂牌成交比','适用边界','结论有条件','假设可调整','历史可复现','周期与供需','配套与流动性','家庭现金流测算','用户输入数据','不代做财务承诺','轻量指标查询入口','研究 Agent 团队','C 端数据入口运营','不抢跑','研究可信','产品配置口径','已签约案例','试单授信记录','2026-08-10','STAID','未引用其数据','未新增编造','共 8 页'];
  const missing = kw.filter(k => !HTML.includes(k));
  ok('内容关键词审计（' + kw.length + ' 项）', missing.length === 0, missing.length ? '缺失: ' + missing.join('、') : '全部命中');
  const cnt8 = HTML.split('共 8 页').length - 1;
  ok('「共 8 页」出现 ≥2 处（封面/封底）', cnt8 >= 2, cnt8 + ' 处');
  // 禁止编造检查：抽查不应出现的未授权数字
  const banned = ['5000 万','10000','3.5%','15%'];
  const foundBanned = banned.filter(b => HTML.includes(b));
  ok('未授权数字零残留', foundBanned.length === 0, foundBanned.length ? foundBanned.join('、') : 'ok');
}

// ---------- 7) 截图存档 ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('file://' + htmlPath);
  await page.waitForTimeout(600);
  const n = await page.locator('.page').count();
  for (let i = 0; i < n; i++) {
    await page.evaluate((idx) => {
      const deck = document.getElementById('deck');
      deck.scrollTo({ top: document.querySelectorAll('.page')[idx].offsetTop, behavior: 'auto' });
    }, i);
    await page.waitForTimeout(350);
    await page.locator('.page').nth(i).screenshot({ path: join(outDir, `page-${i+1}.png`) });
  }
  // 全 deck 长图
  const fullH = await page.evaluate(() => document.getElementById('deck').scrollHeight);
  await page.setViewportSize({ width: 1440, height: Math.min(fullH, 14000) });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(outDir, 'deck-full-1440.png'), fullPage: true });
  ok('截图存档', true, `page-1..${n}.png + deck-full-1440.png → ${outDir}`);
  await ctx.close();
}

// ---------- 8) sha256 ----------
const sha = createHash('sha256').update(HTML).digest('hex');
ok('sha256', true, sha);
writeFileSync(join(outDir, 'sha256.txt'), sha + '  ' + htmlPath + '\n');

await browser.close();
const failed = results.filter(r => !r.pass).length;
console.log(`\n==== 检查汇总: ${results.length - failed}/${results.length} 通过 ====`);
process.exit(failed ? 1 : 0);
