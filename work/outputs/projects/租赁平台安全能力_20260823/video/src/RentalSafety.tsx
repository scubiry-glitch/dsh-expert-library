import React from 'react';
import {
  AbsoluteFill,
  Img,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from 'remotion';

/* ============================================================
   租赁平台安全能力 · 60s 电影感短视频（2.5D 运镜 + 字卡）
   视觉语言：贝壳蓝 #1a3a5c / 金 #c9a96e / 白底（与研报一致）
   58s = 1740 帧 @ 30fps
   ============================================================ */

const NAVY = '#1a3a5c';
const NAVY_DEEP = '#10263f';
const GOLD = '#c9a96e';
const INK = '#1f2733';
const MUTED = '#5b6570';

/* ---------- 共用：2.5D 页面相机（简化 PageCam） ---------- */
const PageCam: React.FC<{
  src: string;
  from: number;
  dur: number;
  zoomIn?: boolean;
}> = ({src, from, dur, zoomIn = true}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const local = frame - from;
  const prog = interpolate(local, [0, dur], [0, 1], {clamp: true});
  const ease = spring({frame: local, fps, durationInFrames: dur, config: {damping: 120}});
  const zoom = zoomIn ? interpolate(ease, [0, 1], [1.18, 1.02]) : interpolate(ease, [0, 1], [1.0, 1.14]);
  const rotX = interpolate(ease, [0, 1], [5, 0]);
  const fadeIn = interpolate(local, [0, 14], [0, 1], {clamp: true});
  const fadeOut = interpolate(local, [dur - 14, dur], [1, 0], {clamp: true});
  return (
    <AbsoluteFill
      style={{
        opacity: fadeIn * fadeOut,
        transform: `perspective(1100px) rotateX(${rotX}deg) scale(${zoom})`,
        transformOrigin: '50% 42%',
      }}
    >
      <Img src={staticFile(src)} style={{width: '100%', height: '100%', objectFit: 'cover'}} />
      {/* 底部渐变（字幕衬底） */}
      <AbsoluteFill style={{background: 'linear-gradient(180deg, transparent 62%, rgba(16,38,63,.55) 100%)'}} />
    </AbsoluteFill>
  );
};

/* ---------- 字卡 ---------- */
const TitleCard: React.FC<{
  from: number;
  dur: number;
  kicker?: string;
  title: string;
  sub?: string;
  big?: boolean;
}> = ({from, dur, kicker, title, sub, big = false}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const local = frame - from;
  const p = spring({frame: local, fps, durationInFrames: 26, config: {damping: 130}});
  const fadeOut = interpolate(local, [dur - 12, dur], [1, 0], {clamp: true});
  return (
    <AbsoluteFill style={{background: `linear-gradient(155deg, ${NAVY_DEEP}, ${NAVY} 60%, #24496f)`, opacity: fadeOut}}>
      <AbsoluteFill
        style={{
          display: 'flex', flexDirection: 'column', justifyContent: 'center',
          padding: '0 120px',
        }}
      >
        {kicker ? (
          <div
            style={{
              color: GOLD, fontSize: 22, letterSpacing: '0.42em', fontWeight: 600,
              marginBottom: 26, opacity: p, transform: `translateY(${(1 - p) * 30}px)`,
            }}
          >
            {kicker}
          </div>
        ) : null}
        <div
          style={{
            color: '#f4f7fb', fontSize: big ? 64 : 48, lineHeight: 1.35, fontWeight: 700,
            letterSpacing: '0.02em', opacity: p, transform: `translateY(${(1 - p) * 36}px)`,
          }}
        >
          {title}
        </div>
        {sub ? (
          <div
            style={{
              color: '#c6d2e0', fontSize: 24, lineHeight: 1.6, marginTop: 26,
              opacity: interpolate(local, [18, 34], [0, 1], {clamp: true}),
            }}
          >
            {sub}
          </div>
        ) : null}
      </AbsoluteFill>
      <div style={{position: 'absolute', left: 0, right: 0, top: 0, height: 4, background: `linear-gradient(90deg, transparent, ${GOLD} 30%, ${GOLD} 70%, transparent)`}} />
    </AbsoluteFill>
  );
};

/* ---------- KPI 数字场景 ---------- */
const KPIScene: React.FC<{from: number; dur: number}> = ({from, dur}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const local = frame - from;
  const fadeOut = interpolate(local, [dur - 12, dur], [1, 0], {clamp: true});
  const kpis = [
    {v: '12.7', u: '/万套', l: '每万套风险发生量 · 2026Q1', c: '#fff'},
    {v: '-42%', u: '', l: '漏气发生量同比 · 闭环见效', c: '#9fd8b4'},
    {v: '2.5', u: '万套', l: '18个月拦截风险房源', c: '#fff'},
    {v: '10', u: '万套+', l: '成都燃气联合管控在管', c: '#fff'},
  ];
  return (
    <AbsoluteFill style={{background: NAVY_DEEP, opacity: fadeOut}}>
      <div style={{position: 'absolute', left: 0, right: 0, top: 0, height: 4, background: `linear-gradient(90deg, transparent, ${GOLD} 30%, ${GOLD} 70%, transparent)`}} />
      <AbsoluteFill style={{display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 110px'}}>
        <div style={{color: GOLD, fontSize: 22, letterSpacing: '0.42em', fontWeight: 600, marginBottom: 54}}>
          证据 · 数字会说话
        </div>
        <div style={{display: 'flex', gap: 28}}>
          {kpis.map((k, i) => {
            const start = 10 + i * 16;
            const p = spring({frame: local - start, fps, durationInFrames: 22, config: {damping: 120}});
            const visible = p > 0 ? p : 0;
            return (
              <div
                key={i}
                style={{
                  flex: 1, background: 'rgba(255,255,255,.07)',
                  border: '1px solid rgba(255,255,255,.16)', borderTop: `3px solid ${GOLD}`,
                  borderRadius: 12, padding: '26px 22px', textAlign: 'center',
                  opacity: visible, transform: `translateY(${(1 - visible) * 44}px) scale(${0.92 + visible * 0.08})`,
                }}
              >
                <div style={{fontSize: 54, fontWeight: 700, color: k.c, lineHeight: 1.1}}>
                  {k.v}
                  <span style={{fontSize: 22, color: GOLD, marginLeft: 4}}>{k.u}</span>
                </div>
                <div style={{fontSize: 17, color: '#aebfd2', marginTop: 14, lineHeight: 1.45}}>{k.l}</div>
              </div>
            );
          })}
        </div>
        <div style={{color: '#7e92a8', fontSize: 15, marginTop: 30, letterSpacing: '0.04em'}}>
          企业披露口径 · 统计口径需第三方核验
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/* ---------- 字幕 ---------- */
const Caption: React.FC<{text: string}> = ({text}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const p = spring({frame, fps, durationInFrames: 18, config: {damping: 140}});
  return (
    <AbsoluteFill style={{justifyContent: 'flex-end', padding: '0 0 54px 0', alignItems: 'center'}}>
      <div
        style={{
          color: 'rgba(255,255,255,.92)', fontSize: 21, letterSpacing: '0.06em',
          background: 'rgba(16,38,63,.72)', borderLeft: `3px solid ${GOLD}`,
          padding: '12px 26px', borderRadius: 6, opacity: p, transform: `translateY(${(1 - p) * 16}px)`,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

/* ---------- 主序列 ---------- */
export const RentalSafety: React.FC = () => {
  return (
    <AbsoluteFill style={{background: '#10263f', fontFamily: '"Noto Sans CJK SC","PingFang SC","Microsoft YaHei",sans-serif'}}>
      {/* 1. 封面 2.5D 推近（0–360f，12s） */}
      <Sequence from={0} durationInFrames={360}>
        <PageCam src="cover.png" from={0} dur={360} zoomIn />
        <Sequence from={40}>
          <Caption text="租赁平台安全能力 · 成都样本评析" />
        </Sequence>
      </Sequence>

      {/* 2. 核心结论字卡（360–660f，10s） */}
      <Sequence from={360} durationInFrames={300}>
        <TitleCard
          from={0} dur={300} kicker="核心结论"
          title="能溢价的是确定性，不是保证"
          sub="租客愿意为「我知道风险、我看到整改、我有人赔付」付费——没有人能买到「绝对安全」"
          big
        />
      </Sequence>

      {/* 3. KPI 数字场景（660–1020f，12s） */}
      <Sequence from={660} durationInFrames={360}>
        <KPIScene from={0} dur={360} />
      </Sequence>

      {/* 4. 关键事实截图运镜（1020–1380f，12s） */}
      <Sequence from={1020} durationInFrames={360}>
        <PageCam src="sec_facts.png" from={0} dur={360} zoomIn />
        <Sequence from={30}>
          <Caption text="燃气在改善、电气在原地：偏科不是态度问题，是结构问题" />
        </Sequence>
      </Sequence>

      {/* 5. 收束字卡（1380–1740f，12s） */}
      <Sequence from={1380} durationInFrames={360}>
        <TitleCard
          from={0} dur={360} kicker="一句话收束"
          title="平台做的是确定性生意，不是安全保证生意"
          sub="确定性可以溢价，保证只能带来无限责任"
          big
        />
        <Sequence from={210}>
          <div style={{position: 'absolute', bottom: 40, width: '100%', textAlign: 'center', color: '#7e92a8', fontSize: 17, letterSpacing: '0.24em'}}>
            98wiki ｜ 智见 / 行业研究报告 · 2026-08-23
          </div>
        </Sequence>
      </Sequence>
    </AbsoluteFill>
  );
};
