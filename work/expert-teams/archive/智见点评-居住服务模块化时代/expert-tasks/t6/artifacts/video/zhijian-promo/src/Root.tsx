import { Composition } from 'remotion';
import { ZhijianMain, ZHIJIAN_TOTAL } from './zhijian/Main';

export const Root: React.FC = () => {
  return (
    <Composition
      id="ZhijianPromo"
      component={ZhijianMain}
      durationInFrames={ZHIJIAN_TOTAL}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
