import { interpolate, useCurrentFrame } from 'remotion';

const SANS = '"Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif';

/** Screen-space narration caption: navy info-strip at the bottom, led by a
 * gold square. Fades/rises in over 8 frames and fades out over the last 8. */
export const BankCaption: React.FC<{ text: string; duration: number; bottom?: number }> = ({
  text, duration, bottom = 76,
}) => {
  const frame = useCurrentFrame();
  const inT = interpolate(frame, [0, 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const outT = interpolate(frame, [duration - 8, duration], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <div
      style={{
        position: 'absolute', left: 0, right: 0, bottom,
        display: 'flex', justifyContent: 'center', alignItems: 'baseline', gap: 14,
        fontFamily: SANS, fontSize: 24, letterSpacing: '0.08em',
        color: '#dfe5f4',
        opacity: inT * outT,
        transform: `translateY(${(1 - inT) * 8}px)`,
        pointerEvents: 'none',
        textShadow: '0 2px 14px rgba(13,25,54,0.55)',
      }}
    >
      <span style={{ width: 7, height: 7, background: '#C9A227', display: 'inline-block' }} />
      <span>{text}</span>
    </div>
  );
};
