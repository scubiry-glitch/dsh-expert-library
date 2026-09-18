import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
} from 'remotion';

export const FPS = 24;

const INTRO = 120; // 5s
const SHOT = 132; // 5.5s
const FADE = 14;
const STEP = SHOT - FADE; // 118
const OUTRO = 132; // 4.5s
const LAST_SHOT_START = INTRO + 10 * STEP;
export const TOTAL = LAST_SHOT_START + SHOT + OUTRO; // 1564 frames ≈ 65s

const NAVY = ['#15213F', '#1D2F5E', '#27427F'];
const GOLD = '#E8A33D';
const PAPER = '#EDF0F6';
const INK = '#121A2B';

const SHOTS: {
  img: string;
  caption: string;
  num: string;
  pan: 'left' | 'right' | 'up' | 'down';
}[] = [
  { img: '01-hero.png', caption: '主基调：该托底，窗口已开', num: '2.29%', pan: 'left' },
  { img: '02-discipline.png', caption: '执行纪律五条', num: '6 折', pan: 'right' },
  { img: '03-kpi.png', caption: '租先于售、量先于价', num: '12,074 套/月', pan: 'left' },
  { img: '04-charts.png', caption: '7 月环比转正', num: '+1.56%', pan: 'right' },
  { img: '05-policy.png', caption: '政策窗口已开', num: '1.75%', pan: 'left' },
  { img: '06-risk.png', caption: '法拍：风险是定价项', num: '3%-6%', pan: 'right' },
  { img: '07-model.png', caption: '三低模型 · 三通道', num: '2.85%', pan: 'left' },
  { img: '08-model2.png', caption: 'B2B 长租约压舱石', num: '≥90%', pan: 'right' },
  { img: '09-uncertainty.png', caption: '不确定性与重启闸门', num: '≥2.5%', pan: 'left' },
  { img: '10-watch.png', caption: '未来关注：八个信号', num: '9-10 月', pan: 'right' },
  { img: '11-appendix.png', caption: '口径与来源', num: '政研通 · Wind', pan: 'up' },
];

const Shot: React.FC<{ index: number }> = ({ index }) => {
  const frame = useCurrentFrame();
  const s = SHOTS[index];
  const from = INTRO + index * STEP;
  // 2.5D: scale up + directional drift
  const scale = interpolate(frame, [0, SHOT], [1.02, 1.14], {
    extrapolateRight: 'clamp',
  });
  const drift = interpolate(frame, [0, SHOT], [-26, 26], {
    extrapolateRight: 'clamp',
  });
  const tx = s.pan === 'left' ? drift : s.pan === 'right' ? -drift : 0;
  const ty = s.pan === 'up' ? drift : s.pan === 'down' ? -drift : 0;
  const opacity = Math.min(
    interpolate(frame, [0, FADE], [0, 1], { extrapolateLeft: 'clamp' }),
    interpolate(frame, [SHOT - FADE, SHOT], [1, 0], { extrapolateRight: 'clamp' })
  );
  const capY = interpolate(frame, [FADE, FADE + 18], [26, 0], {
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill style={{ opacity }}>
      <AbsoluteFill
        style={{
          transform: `scale(${scale}) translate(${tx}px, ${ty}px)`,
          background: PAPER,
        }}
      >
        <Img
          src={staticFile(s.img)}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </AbsoluteFill>
      {/* bottom scrim + caption */}
      <AbsoluteFill
        style={{
          justifyContent: 'flex-end',
          background:
            'linear-gradient(to top, rgba(8,14,28,.78) 0%, rgba(8,14,28,.42) 34%, transparent 62%)',
        }}
      >
        <div
          style={{
            padding: '0 64px 52px',
            transform: `translateY(${capY}px)`,
            opacity: interpolate(frame, [FADE, FADE + 10], [0, 1], {
              extrapolateRight: 'clamp',
            }),
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              fontFamily: '"Noto Sans CJK SC","Microsoft YaHei",sans-serif',
              fontWeight: 700,
              fontSize: 30,
              letterSpacing: '0.06em',
              color: GOLD,
            }}
          >
            <span
              style={{
                width: 46,
                height: 4,
                borderRadius: 2,
                background: GOLD,
                display: 'inline-block',
              }}
            />
            智见点评 · 融合研判
          </div>
          <div
            style={{
              marginTop: 12,
              fontFamily: '"Noto Sans CJK SC","Microsoft YaHei",sans-serif',
              fontWeight: 800,
              fontSize: 46,
              color: '#FFFFFF',
              textShadow: '0 2px 18px rgba(0,0,0,.45)',
            }}
          >
            {s.caption}
          </div>
          <div
            style={{
              marginTop: 10,
              fontFamily: '"Noto Sans CJK SC",sans-serif',
              fontWeight: 700,
              fontSize: 26,
              color: '#DCE5F7',
            }}
          >
            {s.num}
            <span style={{ fontSize: 18, marginLeft: 14, color: '#A9B8D8' }}>
              数据口径见正式稿
            </span>
          </div>
        </div>
      </AbsoluteFill>
      <Audio
        src={staticFile('audio/transition-soft.mp3')}
        volume={0.32}
        startFrom={Math.floor(FPS * 0.35)}
      />
    </AbsoluteFill>
  );
};

const Card: React.FC<{
  kicker: string;
  title: string;
  sub?: string;
  big?: boolean;
}> = ({ kicker, title, sub, big }) => {
  const frame = useCurrentFrame();
  const rise = interpolate(frame, [0, 40], [36, 0], { extrapolateRight: 'clamp' });
  const op = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        alignItems: 'center',
        background: `linear-gradient(135deg, ${NAVY[0]} 0%, ${NAVY[1]} 55%, ${NAVY[2]} 100%)`,
      }}
    >
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(560px 340px at 82% 8%, rgba(232,163,61,.22), transparent 62%)',
        }}
      />
      <div
        style={{
          transform: `translateY(${rise}px)`,
          opacity: op,
          textAlign: 'center',
          padding: '0 90px',
        }}
      >
        <div
          style={{
            fontFamily: '"Noto Sans CJK SC",sans-serif',
            fontWeight: 700,
            fontSize: 24,
            letterSpacing: '0.34em',
            color: GOLD,
          }}
        >
          {kicker}
        </div>
        <div
          style={{
            marginTop: 26,
            fontFamily: '"Noto Sans CJK SC",sans-serif',
            fontWeight: 800,
            fontSize: big ? 68 : 58,
            lineHeight: 1.32,
            color: '#FFFFFF',
            textShadow: '0 3px 26px rgba(0,0,0,.35)',
          }}
        >
          {title}
        </div>
        {sub ? (
          <div
            style={{
              marginTop: 22,
              fontFamily: '"Noto Sans CJK SC",sans-serif',
              fontWeight: 600,
              fontSize: 27,
              color: '#C6D2EE',
            }}
          >
            {sub}
          </div>
        ) : null}
        <div
          style={{
            margin: '34px auto 0',
            width: 96,
            height: 5,
            borderRadius: 3,
            background: GOLD,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

export const ZhiJianPromo: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: NAVY[1] }}>
      <Sequence from={0} durationInFrames={INTRO}>
        <Card
          kicker="智见点评 · 行业研究报告"
          title={'南京江北新区\n「政府+贝壳」合资收储可行性'}
          sub="融合研判（正式稿）· 2026-08"
          big
        />
        <Audio src={staticFile('audio/riser-cine.mp3')} volume={0.55} />
      </Sequence>
      {SHOTS.map((_, i) => (
        <Sequence key={i} from={INTRO + i * STEP} durationInFrames={SHOT}>
          <Shot index={i} />
        </Sequence>
      ))}
      <Sequence from={LAST_SHOT_START + SHOT} durationInFrames={OUTRO}>
        <Card
          kicker="智见点评 · 融合研判"
          title="谢谢观看"
          sub="完整报告：HTML5 / PDF / PPTX · 数字均带口径"
        />
        <Audio src={staticFile('audio/impact-cine.mp3')} volume={0.5} />
      </Sequence>
    </AbsoluteFill>
  );
};
