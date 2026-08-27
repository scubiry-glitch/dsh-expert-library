import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, interpolate, Easing } from 'remotion';
import { PageCam } from './PageCam';
import { BankTitleCard } from './BankTitleCard';
import { BankCaption } from './BankCaption';

const SANS = '"Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif';

// 60.3s @ 30fps — navy-and-gold boardroom promo over the report's real pages.
// Energy: brand open (low) → live pages + title-card breathers (mid) → outro stamp (peak).
export const BANK_SHOTS = {
  open: { from: 0, duration: 195 },    // 0–6.5s   brand lockup + cover page pan
  card1: { from: 195, duration: 60 },  // 6.5–8.5s "把非金融入口变成金融闭环"
  kpi: { from: 255, duration: 250 },   // 8.5–16.8s section 一 KPI band camera
  card2: { from: 505, duration: 60 },  // 16.8–18.8s "任务链分工"
  plat: { from: 565, duration: 250 },  // 18.8–27.2s section 二 platform cards
  card3: { from: 815, duration: 60 },  // 27.2–29.2s "先有服务关系，后有资产负债表"
  chart: { from: 875, duration: 230 }, // 29.2–36.9s section 三 charts push
  card4: { from: 1105, duration: 60 }, // 36.9–38.9s "90天双场景试点"
  plan: { from: 1165, duration: 240 }, // 38.9–46.9s section 五 arch + loops
  outro: { from: 1405, duration: 405 },// 46.9–60.3s conclusion rise + wordmark stamp
} as const; // sum = 1810

export const BANK_TOTAL = 1810;

const CAPTIONS = [
  { from: 300, duration: 150, text: '财务已验证逻辑：中收 +53.9% · 存款成本率 1.32%' },
  { from: 600, duration: 150, text: '波波知了管经营 · 数字人力管组织 · 任务链分工' },
  { from: 915, duration: 150, text: '差距在结构：私行AUM 13.9% vs 29.4%' },
  { from: 1200, duration: 150, text: '一套底座 · 两条主线 · 三个金融闭环' },
] as const;

const SFX: { from: number; src: string; volume: number }[] = [
  { from: 12, src: 'transition-soft.mp3', volume: 0.4 },
  { from: 92, src: 'whoosh-fast.mp3', volume: 0.45 },   // brand → cover page
  { from: 195, src: 'swoosh-quick.mp3', volume: 0.4 },  // title card 1
  { from: 262, src: 'transition-soft.mp3', volume: 0.4 }, // kpi start
  { from: 300, src: 'whoosh-big.mp3', volume: 0.5 },    // push into KPI row
  { from: 400, src: 'whoosh-fast.mp3', volume: 0.35 },  // drift
  { from: 505, src: 'swoosh-quick.mp3', volume: 0.4 },  // title card 2
  { from: 572, src: 'transition-soft.mp3', volume: 0.4 },
  { from: 640, src: 'whoosh-big.mp3', volume: 0.45 },   // pan across platforms
  { from: 750, src: 'whoosh-fast.mp3', volume: 0.32 },
  { from: 815, src: 'swoosh-quick.mp3', volume: 0.4 },  // title card 3
  { from: 882, src: 'transition-soft.mp3', volume: 0.4 },
  { from: 940, src: 'whoosh-big.mp3', volume: 0.5 },    // push to bars
  { from: 1040, src: 'whoosh-fast.mp3', volume: 0.32 },
  { from: 1105, src: 'swoosh-quick.mp3', volume: 0.4 }, // title card 4
  { from: 1172, src: 'transition-soft.mp3', volume: 0.4 },
  { from: 1240, src: 'whoosh-big.mp3', volume: 0.45 },  // arch sweep
  { from: 1405, src: 'riser-cine.mp3', volume: 0.5 },   // outro riser
  { from: 1500, src: 'whoosh-big.mp3', volume: 0.45 },  // page settle
  { from: 1570, src: 'impact-cine.mp3', volume: 0.55 }, // wordmark stamp
  { from: 1600, src: 'sparkle.mp3', volume: 0.3 },      // rule + tagline
];

/** Brand lockup + cover page rise. */
const SceneOpen: React.FC = () => {
  const frame = useCurrentFrame();
  const wm = interpolate(frame, [6, 40], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.2, 0.75, 0.3, 1) });
  const sub = interpolate(frame, [30, 48], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const pageIn = interpolate(frame, [88, 150], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.33, 0, 0.15, 1) });
  return (
    <AbsoluteFill style={{ backgroundColor: '#0d1936' }}>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', opacity: 1 - pageIn * 0.96 }}>
        <div style={{ fontFamily: SANS, fontSize: 148, fontWeight: 900, color: '#f8faff', letterSpacing: '0.04em', opacity: wm, transform: `scale(${1.3 - 0.3 * wm})`, filter: `blur(${(1 - wm) * 10}px)` }}>
          智见点评
        </div>
        <div style={{ marginTop: 26, width: 260, height: 4, borderRadius: 2, background: '#C9A227', transform: `scaleX(${wm})` }} />
        <div style={{ marginTop: 26, fontFamily: SANS, fontSize: 34, letterSpacing: '0.24em', color: '#aeb8d2', opacity: sub }}>
          行业研究报告 · 行领导汇报
        </div>
      </div>
      <div style={{ position: 'absolute', inset: 0, opacity: pageIn, transform: `translateY(${(1 - pageIn) * 60}px)` }}>
        <PageCam
          src="textures/live/bank-cover-full.png"
          pageH={590}
          keys={[
            { frame: 0, cx: 640, cy: 300, zoom: 0.92 },
            { frame: 40, cx: 640, cy: 300, zoom: 1.05 },
            { frame: 90, cx: 650, cy: 315, zoom: 1.12, rotX: 3, rotZ: 0, persp: 1500 },
            { frame: 105, cx: 650, cy: 315, zoom: 1.12, rotX: 0 },
          ]}
          saturate={1.06}
        />
      </div>
    </AbsoluteFill>
  );
};

/** Wordmark stamp for the outro (riser → impact → sparkle, then ≥1s hold). */
const SceneStamp: React.FC = () => {
  const frame = useCurrentFrame();
  const local = frame - 165; // starts at outro frame 165
  const t = interpolate(local, [0, 18], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.2, 0.9, 0.25, 1) });
  const glint = interpolate(local, [26, 42], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const fadeOut = interpolate(frame, [392, 405], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ backgroundColor: '#0d1936', opacity: fadeOut, alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center', transform: `scale(${1.5 - 0.5 * t})`, opacity: t }}>
        <div style={{ fontFamily: SANS, fontSize: 132, fontWeight: 900, color: '#f8faff', letterSpacing: '0.05em' }}>
          智见点评
        </div>
      </div>
      <div style={{ marginTop: 30, width: 320, height: 4, borderRadius: 2, background: '#C9A227', transform: `scaleX(${glint})` }} />
      <div style={{ marginTop: 26, fontFamily: SANS, fontSize: 30, letterSpacing: '0.14em', color: '#aeb8d2', opacity: glint }}>
        把方便留给客户 · 把复杂留给自己
      </div>
    </AbsoluteFill>
  );
};

export const BankMain: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: '#0d1936' }}>
      {SFX.map((s, i) => (
        <Sequence key={`sfx-${i}`} from={s.from} durationInFrames={90}>
          <Audio src={staticFile(`audio/${s.src}`)} volume={s.volume} />
        </Sequence>
      ))}

      <Sequence from={BANK_SHOTS.open.from} durationInFrames={BANK_SHOTS.open.duration}>
        <SceneOpen />
      </Sequence>

      <Sequence from={BANK_SHOTS.card1.from} durationInFrames={BANK_SHOTS.card1.duration}>
        <BankTitleCard
          duration={BANK_SHOTS.card1.duration}
          words={[{ text: '把非金融入口变成' }, { text: '金融闭环', accent: true }]}
          sub="宁波银行 · 2026H1 · 营收 +11.54%"
        />
      </Sequence>

      <Sequence from={BANK_SHOTS.kpi.from} durationInFrames={BANK_SHOTS.kpi.duration}>
        <PageCam
          src="textures/live/bank-s1-full.png"
          pageH={915}
          keys={[
            { frame: 0, cx: 640, cy: 420, zoom: 0.95, rotX: 9, persp: 1500 },
            { frame: 45, cx: 640, cy: 430, zoom: 1.0, rotX: 0 },
            { frame: 120, cx: 640, cy: 260, zoom: 1.42 },
            { frame: 250, cx: 690, cy: 275, zoom: 1.48 },
          ]}
          saturate={1.04}
        />
      </Sequence>

      <Sequence from={BANK_SHOTS.card2.from} durationInFrames={BANK_SHOTS.card2.duration}>
        <BankTitleCard
          duration={BANK_SHOTS.card2.duration}
          words={[{ text: '按企业' }, { text: '任务链', accent: true }, { text: '分工' }]}
          sub="波波知了 × 数字人力 · 同一企业可同时使用"
        />
      </Sequence>

      <Sequence from={BANK_SHOTS.plat.from} durationInFrames={BANK_SHOTS.plat.duration}>
        <PageCam
          src="textures/live/bank-s2-full.png"
          pageH={748}
          keys={[
            { frame: 0, cx: 640, cy: 360, zoom: 0.95, rotX: 8, persp: 1500 },
            { frame: 40, cx: 640, cy: 370, zoom: 1.0, rotX: 0 },
            { frame: 120, cx: 960, cy: 380, zoom: 1.38 },
            { frame: 250, cx: 1000, cy: 400, zoom: 1.45 },
          ]}
          saturate={1.04}
        />
      </Sequence>

      <Sequence from={BANK_SHOTS.card3.from} durationInFrames={BANK_SHOTS.card3.duration}>
        <BankTitleCard
          duration={BANK_SHOTS.card3.duration}
          words={[{ text: '先有服务关系' }, { text: '后有资产负债表', accent: true }]}
        />
      </Sequence>

      <Sequence from={BANK_SHOTS.chart.from} durationInFrames={BANK_SHOTS.chart.duration}>
        <PageCam
          src="textures/live/bank-s3-full.png"
          pageH={1280}
          keys={[
            { frame: 0, cx: 700, cy: 980, zoom: 1.12, rotX: 7, persp: 1600 },
            { frame: 45, cx: 700, cy: 985, zoom: 1.18, rotX: 0 },
            { frame: 130, cx: 640, cy: 1010, zoom: 1.55 },
            { frame: 230, cx: 660, cy: 1000, zoom: 1.5 },
          ]}
          saturate={1.05}
        />
      </Sequence>

      <Sequence from={BANK_SHOTS.card4.from} durationInFrames={BANK_SHOTS.card4.duration}>
        <BankTitleCard
          duration={BANK_SHOTS.card4.duration}
          words={[{ text: '90天', accent: true }, { text: '双场景试点' }]}
          sub="让试点说话 · 让沉淀算数"
        />
      </Sequence>

      <Sequence from={BANK_SHOTS.plan.from} durationInFrames={BANK_SHOTS.plan.duration}>
        <PageCam
          src="textures/live/bank-s5-full.png"
          pageH={815}
          keys={[
            { frame: 0, cx: 640, cy: 300, zoom: 1.08, rotX: 8, persp: 1600 },
            { frame: 40, cx: 640, cy: 310, zoom: 1.12, rotX: 0 },
            { frame: 130, cx: 640, cy: 480, zoom: 1.42 },
            { frame: 240, cx: 690, cy: 500, zoom: 1.5 },
          ]}
          saturate={1.04}
        />
      </Sequence>

      <Sequence from={BANK_SHOTS.outro.from} durationInFrames={BANK_SHOTS.outro.duration}>
        <PageCam
          src="textures/live/bank-s9-full.png"
          pageH={516}
          keys={[
            { frame: 0, cx: 640, cy: 260, zoom: 0.98 },
            { frame: 60, cx: 640, cy: 265, zoom: 1.2, rotX: 4, persp: 1700 },
            { frame: 150, cx: 640, cy: 268, zoom: 1.26, rotX: 0 },
          ]}
          saturate={1.06}
        />
        <SceneStamp />
      </Sequence>

      {CAPTIONS.map((c) => (
        <Sequence key={c.from} from={c.from} durationInFrames={c.duration}>
          <BankCaption text={c.text} duration={c.duration} />
        </Sequence>
      ))}

      {[BANK_SHOTS.kpi.from, BANK_SHOTS.plat.from, BANK_SHOTS.chart.from, BANK_SHOTS.plan.from, BANK_SHOTS.outro.from].map((cut) => (
        <Sequence key={`fc-${cut}`} from={cut - 5} durationInFrames={10}>
          <FlashCutLocal />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

/** Bright-field cut: warm-white bloom over the hard cut (navy-branded). */
const FlashCutLocal: React.FC = () => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, 4, 10], [0, 0.8, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', opacity: o, background: 'radial-gradient(ellipse at 50% 45%, rgba(248,251,255,0.96), rgba(232,238,250,0.5) 55%, transparent 80%)' }} />
  );
};
