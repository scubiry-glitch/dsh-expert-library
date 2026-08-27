import { AbsoluteFill, interpolate, useCurrentFrame, Easing } from 'remotion';

const SANS = '"Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif';

/** Bank title card: deep-navy field, heavy sans statement, gold accent word,
 * gold rule growing beneath, mono sub-line. */
export const BankTitleCard: React.FC<{
  duration: number;
  words: { text: string; accent?: boolean }[];
  sub?: string;
}> = ({ duration, words, sub }) => {
  const frame = useCurrentFrame();
  const fadeOut = interpolate(frame, [duration - 8, duration], [1, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const underline = interpolate(frame, [14, 30], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.3, 0, 0.2, 1),
  });
  const subT = interpolate(frame, [10, 20], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: '#0d1936',
        justifyContent: 'center',
        alignItems: 'center',
        opacity: fadeOut,
        backgroundImage:
          'radial-gradient(1100px 750px at 50% 42%, rgba(45,91,216,0.28), transparent 65%), radial-gradient(900px 500px at 82% 8%, rgba(201,162,39,0.16), transparent 60%)',
      }}
    >
      <div style={{ textAlign: 'center', maxWidth: 1600 }}>
        <div
          style={{
            fontFamily: SANS, fontSize: 100, fontWeight: 900, lineHeight: 1.22,
            color: '#f8faff', letterSpacing: '-0.01em',
            display: 'flex', flexWrap: 'wrap', justifyContent: 'center', columnGap: '0.24em',
          }}
        >
          {words.map((w, i) => {
            const delay = 4 + i * 4;
            const t = interpolate(frame, [delay, delay + 9], [0, 1], {
              extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.2, 0.75, 0.3, 1),
            });
            return (
              <span
                key={i}
                style={{
                  opacity: t,
                  transform: `scale(${1.24 - 0.24 * t})`,
                  filter: `blur(${(1 - t) * 7}px)`,
                  display: 'inline-block',
                  color: w.accent ? '#C9A227' : undefined,
                }}
              >
                {w.text}
              </span>
            );
          })}
        </div>
        <div style={{ height: 5, width: 240, margin: '34px auto 0', borderRadius: 3, background: '#C9A227', transform: `scaleX(${underline})` }} />
        {sub ? (
          <div style={{ fontFamily: SANS, fontSize: 27, letterSpacing: '0.10em', color: '#aeb8d2', marginTop: 30, opacity: subT, textTransform: 'uppercase' }}>
            {sub}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
