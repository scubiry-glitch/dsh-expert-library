import { AbsoluteFill, Audio, Easing, Img, Sequence, staticFile, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Caption } from './Caption';
import { DigitRoll } from './DigitRoll';
import { FlashCut } from './FlashCut';

/* ============================================================
   智见点评 · 居住服务模块化时代 — 60s 宣传短片（讨论稿版）
   视觉语言：贝壳蓝金（深青底 #10242c / 青蓝 #0b7a8c / 金 #e0a53a）
   结构：标题(11s) → 主基调(12s) → 三组事实(12s) → 展望(11s)
        → 数字落定收尾(14s) = 1800 帧 @ 30fps = 60s
   质感规则（video-shotcraft）：
   - 2.5D 运镜全部用真实页面 2x 截图（PageCam 简化版：平移+缩放插值）
   - 落定后必呼吸：结尾字标 hold ≥30 帧
   - 一种手法只当一次主角：标题逐字入场 / 数字里程表滚动 / 页面平移推近
   - SFX 句式：开场 whoosh → 切点 transition → 收尾 riser→impact→sparkle
   - 确定性渲染：无随机数
   ============================================================ */

export const ZHIJIAN_TOTAL = 1800;

const FONT = '"Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif';
const INK = '#13262e';
const TEAL_DEEP = '#10242c';
const TEAL = '#0b7a8c';
const GOLD = '#e0a53a';

/* ---------- 2.5D 页面相机：整页截图 + 平移/缩放插值 ---------- */
export const PanZoom: React.FC<{
  src: string;
  z1: number; z2: number;
  x1: number; x2: number;
  y1: number; y2: number;
  baseW?: number;
}> = ({ src, z1, z2, x1, x2, y1, y2, baseW = 1916 }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const E = Easing.inOut(Easing.cubic);
  const zoom = interpolate(frame, [0, durationInFrames], [z1, z2], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: E,
  });
  const x = interpolate(frame, [0, durationInFrames], [x1, x2], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: E,
  });
  const y = interpolate(frame, [0, durationInFrames], [y1, y2], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: E,
  });
  return (
    <AbsoluteFill style={{ background: TEAL_DEEP, overflow: 'hidden' }}>
      <Img
        src={staticFile(`shots/${src}`)}
        style={{
          width: baseW,
          transform: `translate(${x}px, ${y}px) scale(${zoom})`,
          transformOrigin: '50% 50%',
          willChange: 'transform',
        }}
      />
      {/* 底部渐变保证字幕可读 */}
      <AbsoluteFill style={{ background: 'linear-gradient(180deg, transparent 55%, rgba(16,36,44,0.55) 100%)' }} />
    </AbsoluteFill>
  );
};

/* ---------- 标题幕（开场） ---------- */
const TitleScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const zoom = interpolate(frame, [0, 330], [1, 1.055], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.cubic),
  });
  const line1 = '居住服务进入';
  const line2 = '「专业角色可拆分 · 可验证 · 可单独付费」时代？';
  const brandIn = spring({ frame, fps, delay: 6, config: { damping: 200 } });
  const subIn = spring({ frame, fps, delay: 78, config: { damping: 200 } });
  const barIn = spring({ frame, fps, delay: 96, config: { damping: 200 } });
  const Char: React.FC<{ ch: string; i: number; base: number; size: number; gold?: boolean }> = ({ ch, i, base, size, gold }) => {
    const s = spring({ frame, fps, delay: base + i * 2.2, config: { damping: 14, stiffness: 120 } });
    return (
      <span style={{
        display: 'inline-block', fontSize: size, fontWeight: 800, color: gold ? GOLD : '#ffffff',
        opacity: s, transform: `translateY(${(1 - s) * 26}px)`,
        fontFamily: FONT, letterSpacing: '0.02em',
      }}>{ch}</span>
    );
  };
  return (
    <AbsoluteFill style={{ background: TEAL_DEEP, overflow: 'hidden' }}>
      {/* 深青底 + 金色径向光 */}
      <AbsoluteFill style={{
        background:
          'radial-gradient(900px 520px at 82% -12%, rgba(43,184,201,0.32), transparent 60%),' +
          'radial-gradient(760px 460px at -8% 30%, rgba(224,165,58,0.14), transparent 60%)',
        transform: `scale(${zoom})`,
      }} />
      <AbsoluteFill style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 140px' }}>
        <div style={{ opacity: brandIn, display: 'flex', alignItems: 'center', gap: 14, marginBottom: 34 }}>
          <span style={{
            fontFamily: FONT, fontSize: 20, fontWeight: 700, letterSpacing: '0.2em', color: '#9fc4cc',
            border: '1px solid rgba(224,165,58,0.45)', background: 'rgba(224,165,58,0.10)',
            borderRadius: 999, padding: '8px 22px',
          }}>智见点评 · 居住服务系列</span>
          <span style={{
            fontFamily: FONT, fontSize: 20, fontWeight: 700, letterSpacing: '0.2em', color: '#e8f1f3',
            border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.06)',
            borderRadius: 999, padding: '8px 22px',
          }}>融合研判 · 讨论稿</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', maxWidth: 1560, lineHeight: 1.35 }}>
          {line1.split('').map((ch, i) => <Char key={i} ch={ch} i={i} base={14} size={92} />)}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', maxWidth: 1560, lineHeight: 1.4, marginTop: 8 }}>
          {line2.split('').map((ch, i) => <Char key={i} ch={ch} i={i} base={34} size={66} gold={ch === '拆' || ch === '验' || ch === '付'} />)}
        </div>
        <div style={{
          width: 220, height: 5, borderRadius: 3, marginTop: 46, background: `linear-gradient(90deg, ${GOLD}, ${TEAL})`,
          opacity: barIn, transform: `scaleX(${barIn})`, transformOrigin: 'left',
        }} />
        <div style={{ opacity: subIn, marginTop: 26, fontFamily: FONT, fontSize: 24, color: '#b9d2d9', letterSpacing: '0.06em' }}>
          从「一名经纪人包办一单」到「客户管家 × 懂盘者 × 履约模块」 ｜ 2026-08 ｜ 匿名标注 Y / C / L / X
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/* ---------- 收尾：数字落定 + 字标 hold ---------- */
const OutroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const zoom = interpolate(frame, [0, 420], [1, 1.1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.cubic),
  });
  const titleIn = spring({ frame, fps, delay: 190, config: { damping: 200 } });
  const tagIn = spring({ frame, fps, delay: 210, config: { damping: 200 } });
  const Row: React.FC<{ value: string; unit: string; label: string; delay: number; size?: number }> = ({ value, unit, label, delay, size = 108 }) => (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 18 }}>
      <DigitRoll value={value} delay={delay} fontSize={size} color={GOLD} />
      <span style={{ fontFamily: FONT, fontSize: 44, fontWeight: 700, color: '#ffffff' }}>{unit}</span>
      <span style={{ fontFamily: FONT, fontSize: 24, color: '#b9d2d9', letterSpacing: '0.08em', marginLeft: 8 }}>{label}</span>
    </div>
  );
  return (
    <AbsoluteFill style={{ background: TEAL_DEEP, overflow: 'hidden' }}>
      <Img src={staticFile('shots/sec-s7.png')} style={{
        width: 1916, transform: `scale(${zoom})`, transformOrigin: '50% 60%', willChange: 'transform', opacity: 0.5,
      }} />
      <AbsoluteFill style={{ background: 'linear-gradient(180deg, rgba(16,36,44,0.82), rgba(10,30,38,0.92))' }} />
      <AbsoluteFill style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 40 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 30, alignItems: 'flex-start' }}>
          <Row value="5" unit="万+" label="承接线索 · 5–7月" delay={18} />
          <Row value="7.4" unit="%" label="转带看率 · vs 大盘 5.0%" delay={70} />
          <Row value="14.6" unit="%" label="Q2 利润率 · 2026" delay={122} />
        </div>
        <div style={{
          width: 460, height: 4, borderRadius: 2, marginTop: 8,
          background: `linear-gradient(90deg, ${TEAL}, ${GOLD})`,
          opacity: titleIn, transform: `scaleX(${titleIn})`, transformOrigin: 'center',
        }} />
        <div style={{ opacity: titleIn, textAlign: 'center' }}>
          <div style={{ fontFamily: FONT, fontSize: 54, fontWeight: 800, color: '#ffffff', letterSpacing: '0.08em' }}>
            智见点评 · 融合研判（讨论稿）
          </div>
          <div style={{ fontFamily: FONT, fontSize: 22, color: '#9fc4cc', marginTop: 14, letterSpacing: '0.1em' }}>
            居住服务进入「专业角色可拆分、可验证、可单独付费」时代？
          </div>
        </div>
        <div style={{ opacity: tagIn, fontFamily: FONT, fontSize: 20, color: '#8fb4bd', letterSpacing: '0.16em' }}>
          等待确认：转正式稿 · PPT 调整 · 视频精修
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/* ---------- 主时间线 ---------- */
export const ZhijianMain: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: TEAL_DEEP }}>
      {/* 幕 1：标题 0–330 */}
      <Sequence from={0} durationInFrames={330}>
        <TitleScene />
        <Audio src={staticFile('audio/whoosh-big.mp3')} volume={(f) => interpolate(f, [0, 6, 90], [0, 0.5, 0.05], { extrapolateRight: 'clamp' })} />
      </Sequence>

      {/* 幕 2：主基调 + KPI 330–690 */}
      <Sequence from={330} durationInFrames={360}>
        <PanZoom src="sec-s1.png" z1={1.0} z2={1.22} x1={0} x2={-170} y1={-40} y2={-150} />
        <Caption text="主基调：会，而且已经启动 · 三组实证" duration={360} />
        <Audio src={staticFile('audio/whoosh-fast.mp3')} volume={0.4} />
      </Sequence>

      {/* 幕 3：三组事实 690–1050 */}
      <Sequence from={690} durationInFrames={360}>
        <PanZoom src="sec-s3.png" z1={1.05} z2={1.24} x1={150} x2={-150} y1={-120} y2={-260} />
        <Caption text="事实：角色分化 · 量价背离 · 外部挤压" duration={360} />
        <Audio src={staticFile('audio/transition-snap.mp3')} volume={0.45} />
      </Sequence>

      {/* 幕 4：展望 1050–1380 */}
      <Sequence from={1050} durationInFrames={330}>
        <PanZoom src="sec-s6.png" z1={1.0} z2={1.2} x1={0} x2={120} y1={-60} y2={-180} />
        <Caption text="机制链与展望：模块化自我强化" duration={330} />
        <Audio src={staticFile('audio/transition-soft.mp3')} volume={0.45} />
      </Sequence>

      {/* 幕 5：收尾数字 1380–1800 */}
      <Sequence from={1380} durationInFrames={420}>
        <OutroScene />
        <Audio src={staticFile('audio/riser-cine.mp3')} volume={(f) => interpolate(f, [0, 150], [0, 0.5], { extrapolateRight: 'clamp' })} />
      </Sequence>
      <Sequence from={1560}>
        <Audio src={staticFile('audio/impact-cine.mp3')} volume={0.55} />
      </Sequence>
      <Sequence from={1640}>
        <Audio src={staticFile('audio/sparkle.mp3')} volume={0.4} />
      </Sequence>

      {/* 切点暖闪：330 / 690 / 1050 / 1380 */}
      <Sequence from={325} durationInFrames={10}><FlashCut /></Sequence>
      <Sequence from={685} durationInFrames={10}><FlashCut /></Sequence>
      <Sequence from={1045} durationInFrames={10}><FlashCut /></Sequence>
      <Sequence from={1375} durationInFrames={10}><FlashCut /></Sequence>
    </AbsoluteFill>
  );
};
