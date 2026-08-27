import { interpolate, useCurrentFrame } from 'remotion';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** 智见版解说字幕：底部通栏等宽信息条，金角标引导，8 帧淡入 / 末 8 帧淡出。 */
export const Caption: React.FC<{ text: string; duration: number; bottom?: number }> = ({
  text,
  duration,
  bottom = 76,
}) => {
  const frame = useCurrentFrame();
  const inT = interpolate(frame, [0, 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const outT = interpolate(frame, [duration - 8, duration], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <div style={{
      position: 'absolute', left: 0, right: 0, bottom,
      display: 'flex', justifyContent: 'center', alignItems: 'baseline', gap: 14,
      fontFamily: MONO, fontSize: 24, letterSpacing: '0.14em',
      color: 'rgba(232,241,243,0.92)',
      opacity: inT * outT,
      transform: `translateY(${(1 - inT) * 8}px)`,
      pointerEvents: 'none', textShadow: '0 2px 10px rgba(16,36,44,0.7)',
    }}>
      <span style={{ width: 8, height: 8, background: '#e0a53a', display: 'inline-block' }} />
      <span>{text}</span>
    </div>
  );
};
