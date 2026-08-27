import { Composition } from 'remotion';
import { ZjMain, ZJ_TOTAL } from './aifl/Main';

export const Root: React.FC = () => {
  return (
    <Composition
      id="ZjPromo"
      component={ZjMain}
      durationInFrames={ZJ_TOTAL}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
