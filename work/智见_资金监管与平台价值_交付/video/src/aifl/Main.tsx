import { AbsoluteFill, Sequence, staticFile, Audio } from 'remotion';
import { useVideoConfig, useCurrentFrame, interpolate, Easing } from 'remotion';

// 资金监管时代的平台价值 —— 电影感宣传片（贝壳蓝金 · 自主自由创作）
const BLUE = '#0B6390';
const BLUE_DARK = '#0A4E72';
const GOLD = '#9A6B14';
const PAPER = '#F4F3EE';
const INK = '#23262C';
const MUTED = '#5D626A';
const ASSET = '/static/zj_assets/';

const Digit: React.FC<{ value: string; from: number; delay: number }> = ({ value, from, delay }) => {
  const frame = useCurrentFrame();
  const t = frame - from - delay;
  const appear = interpolate(t, [0, 18], [0, 1], { extrapolateRight: 'clamp' });
  const rise = interpolate(t, [0, 22], [28, 0], { extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  return <span style={{ display: 'inline-block', opacity: appear, transform: `translateY(${rise}px)` }}>{value}</span>;
};

const SceneOpen: React.FC = () => {
  const frame = useCurrentFrame();
  const t = frame;
  const wordOpacity = interpolate(t, [0, 20], [0, 1], { extrapolateRight: 'clamp' });
  const wordY = interpolate(t, [0, 24], [30, 0], { extrapolateRight: 'clamp' });
  const zoom = interpolate(t, [55, 175], [0.82, 1.04], { extrapolateRight: 'clamp', easing: Easing.inOut(Easing.cubic) });
  const fadeToShot = interpolate(t, [150, 178], [0, 1], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ background: BLUE_DARK }}>
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', opacity: wordOpacity * (1 - fadeToShot), transform: `translateY(${wordY}px)` }}>
        <div style={{ color: GOLD, fontSize: 28, letterSpacing: 8, textTransform: 'uppercase' }}>BEIKE · 98WIKI</div>
        <div style={{ color: '#fff', fontSize: 72, fontWeight: 700, marginTop: 20, maxWidth: 1200, textAlign: 'center', lineHeight: 1.2 }}>
          资金监管时代的平台价值
        </div>
        <div style={{ color: '#C9D6E0', fontSize: 30, marginTop: 16 }}>钱不进平台 · 确权仍经过平台</div>
      </AbsoluteFill>
      <AbsoluteFill style={{ opacity: fadeToShot, transform: `scale(${zoom})` }}>
        <img src={staticFile(ASSET + 'full_2x.png')} style={{ width: '100%', height: 'auto' }} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const SceneKPI: React.FC = () => {
  const frame = useCurrentFrame();
  const t = frame - 180;
  const titleOp = interpolate(t, [0, 15], [0, 1], { extrapolateRight: 'clamp' });
  const bgScale = interpolate(t, [40, 220], [1.0, 1.18], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ background: PAPER }}>
      <AbsoluteFill style={{ transform: `scale(${bgScale})` }}>
        <img src={staticFile(ASSET + 'view_top.png')} style={{ width: '100%', opacity: 0.22 }} />
      </AbsoluteFill>
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
        <div style={{ opacity: titleOp, textAlign: 'center' }}>
          <div style={{ color: BLUE, fontSize: 30, fontWeight: 600, letterSpacing: 2 }}>监管资金盘子有多大？</div>
          <div style={{ fontSize: 100, fontWeight: 800, color: INK, marginTop: 24 }}>
            <Digit value="270" from={t} delay={0} /><span style={{ fontSize: 48 }}> 亿元</span>
          </div>
          <div style={{ fontSize: 28, color: MUTED, marginTop: 12 }}>长沙存量房资金监管闭环（红网 2025-11）</div>
          <div style={{ fontSize: 62, fontWeight: 700, color: BLUE, marginTop: 42 }}>
            ≈<Digit value="2200" from={t} delay={22} /><span style={{ fontSize: 30 }}> 万/城/年</span>
          </div>
          <div style={{ fontSize: 26, color: MUTED, marginTop: 8 }}>在途利息（自算框架值）—— 输掉的是「伪价值」</div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const SceneEvidence: React.FC = () => {
  const frame = useCurrentFrame();
  const t = frame - 430;
  const leftX = interpolate(t, [0, 30], [-120, 0], { extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  const rightX = interpolate(t, [0, 30], [120, 0], { extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  const plus = interpolate(t, [60, 90], [1, 1.08], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ background: BLUE_DARK, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 60, padding: 60 }}>
      <div style={{ transform: `translateX(${leftX}px)`, background: PAPER, borderRadius: 16, padding: '36px 40px', textAlign: 'center', width: 430 }}>
        <div style={{ color: MUTED, fontSize: 26 }}>监管扩容</div>
        <div style={{ fontSize: 42, fontWeight: 700, color: BLUE_DARK, marginTop: 12 }}>一线 → 县级市</div>
        <div style={{ fontSize: 22, color: MUTED, marginTop: 8 }}>上海 · 湖南 · 赤峰 · 郑州 · 晋江</div>
      </div>
      <div style={{ color: GOLD, fontSize: 60, fontWeight: 800, transform: `scale(${plus})` }}>×</div>
      <div style={{ transform: `translateX(${rightX}px)`, background: PAPER, borderRadius: 16, padding: '36px 40px', textAlign: 'center', width: 430 }}>
        <div style={{ color: MUTED, fontSize: 26 }}>贝壳 2026Q2 二手房单量</div>
        <div style={{ fontSize: 66, fontWeight: 800, color: GOLD, marginTop: 12 }}>
          <Digit value="+25%" from={t} delay={0} />
        </div>
        <div style={{ fontSize: 22, color: MUTED, marginTop: 8 }}>监管与放量并行 —— 互补不是替代</div>
      </div>
    </AbsoluteFill>
  );
};

const SceneKey: React.FC = () => {
  const frame = useCurrentFrame();
  const t = frame - 640;
  const big = interpolate(t, [0, 40], [0.6, 1.0], { extrapolateRight: 'clamp', easing: Easing.out(Easing.back(1.4)) });
  const sub = interpolate(t, [45, 75], [0, 1], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ background: PAPER, justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ color: BLUE, fontSize: 28, fontWeight: 600 }}>房款安全 · 27 城（央广网 2026-06）</div>
      <div style={{ transform: `scale(${big})`, textAlign: 'center', marginTop: 24 }}>
        <span style={{ fontSize: 104, fontWeight: 800, color: BLUE_DARK }}>
          <Digit value="7.1" from={t} delay={0} /><span style={{ fontSize: 44 }}> 万单</span>
        </span>
        <div style={{ fontSize: 34, color: INK, marginTop: 8 }}>风险拦截（事前不放行）</div>
        <div style={{ width: 60, height: 2, background: GOLD, margin: '28px auto' }} />
        <span style={{ fontSize: 74, fontWeight: 800, color: GOLD }}>
          <Digit value="86.3" from={t} delay={22} /><span style={{ fontSize: 36 }}> 万</span>
        </span>
        <div style={{ fontSize: 30, color: MUTED, marginTop: 8 }}>累计垫付（≈12 元/单）</div>
      </div>
      <div style={{ opacity: sub, fontSize: 34, color: BLUE_DARK, fontWeight: 700, marginTop: 36 }}>
        兜底是信息能力，不是资金能力
      </div>
    </AbsoluteFill>
  );
};

const SceneConclusion: React.FC = () => {
  const frame = useCurrentFrame();
  const t = frame - 830;
  const items = [
    { label: '机制 A', text: '平台必输 ✗ 只输「伪价值」', delay: 0 },
    { label: '机制 B', text: '释放决策信息权 ✓ 主导', delay: 18 },
    { label: '机制 C', text: '确定性变现 ✓ 主战场', delay: 36 },
  ];
  return (
    <AbsoluteFill style={{ background: BLUE_DARK, justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ color: GOLD, fontSize: 26, letterSpacing: 3 }}>三机制判定</div>
      {items.map((it, i) => {
        const op = interpolate(t - it.delay, [0, 20], [0, 1], { extrapolateRight: 'clamp' });
        const x = interpolate(t - it.delay, [0, 24], [44, 0], { extrapolateRight: 'clamp' });
        return (
          <div key={it.label} style={{ opacity: op, transform: `translateX(${x}px)`, display: 'flex', alignItems: 'center', gap: 18, marginTop: 22 }}>
            <span style={{ color: GOLD, fontWeight: 800, fontSize: 36, width: 120 }}>{it.label}</span>
            <span style={{ color: '#fff', fontSize: 36 }}>{it.text}</span>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

const SceneOutro: React.FC = () => {
  const frame = useCurrentFrame();
  const t = frame - 1020;
  const op = interpolate(t, [0, 25], [0, 1], { extrapolateRight: 'clamp' });
  const scale = interpolate(t, [0, 30], [0.94, 1.0], { extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  return (
    <AbsoluteFill style={{ background: BLUE_DARK, justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ opacity: op, transform: `scale(${scale})`, textAlign: 'center' }}>
        <div style={{ width: 160, height: 3, background: GOLD, margin: '0 auto 30px auto' }} />
        <div style={{ color: '#fff', fontSize: 60, fontWeight: 800, lineHeight: 1.3, maxWidth: 1400 }}>
          政府管「钱的安全」
          <br />
          平台管「交易的确定性」
        </div>
        <div style={{ color: GOLD, fontSize: 42, fontWeight: 700, marginTop: 36 }}>
          钱不进平台 · 确权仍经过平台
        </div>
        <div style={{ color: '#C9D6E0', fontSize: 24, marginTop: 40 }}>BEIKE · 98WIKI ｜ 智见 / 行业研究报告</div>
        <div style={{ width: 160, height: 3, background: GOLD, margin: '30px auto 0 auto' }} />
      </div>
    </AbsoluteFill>
  );
};

export const ZJ_SHOTS = {
  open: { from: 0, duration: 180 },
  kpi: { from: 180, duration: 250 },
  evidence: { from: 430, duration: 210 },
  key: { from: 640, duration: 190 },
  conclusion: { from: 830, duration: 190 },
  outro: { from: 1020, duration: 180 },
} as const;
export const ZJ_TOTAL = 1200;

// 声音设计（SFX 钉帧：入场/落定/转场/收束）
const SFX: { from: number; src: string; volume: number }[] = [
  { from: 10, src: 'transition-soft.mp3', volume: 0.4 },   // 开场字标
  { from: 150, src: 'whoosh-big.mp3', volume: 0.45 },      // 字标→视觉稿
  { from: 205, src: 'swoosh-quick.mp3', volume: 0.4 },     // 切 KPI 段
  { from: 300, src: 'impact-cine.mp3', volume: 0.5 },      // 270亿 落定
  { from: 470, src: 'whoosh-fast.mp3', volume: 0.4 },      // 切证据段
  { from: 520, src: 'impact-cine.mp3', volume: 0.5 },      // +25% 落定
  { from: 660, src: 'whoosh-fast.mp3', volume: 0.4 },      // 切关键段
  { from: 700, src: 'impact-cine.mp3', volume: 0.55 },     // 7.1万单 落定
  { from: 850, src: 'riser-cine.mp3', volume: 0.45 },      // 切结论段（riser 进结论）
  { from: 1040, src: 'whoosh-big.mp3', volume: 0.45 },     // 切收束
  { from: 1100, src: 'sparkle.mp3', volume: 0.4 },         // 金句定格 sparkle
];

export const ZjMain: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: BLUE_DARK }}>
      {SFX.map((s, i) => (
        <Audio key={i} src={staticFile('audio/' + s.src)} volume={s.volume} startFrom={s.from} />
      ))}
      <Sequence from={ZJ_SHOTS.open.from}><SceneOpen /></Sequence>
      <Sequence from={ZJ_SHOTS.kpi.from}><SceneKPI /></Sequence>
      <Sequence from={ZJ_SHOTS.evidence.from}><SceneEvidence /></Sequence>
      <Sequence from={ZJ_SHOTS.key.from}><SceneKey /></Sequence>
      <Sequence from={ZJ_SHOTS.conclusion.from}><SceneConclusion /></Sequence>
      <Sequence from={ZJ_SHOTS.outro.from}><SceneOutro /></Sequence>
    </AbsoluteFill>
  );
};
