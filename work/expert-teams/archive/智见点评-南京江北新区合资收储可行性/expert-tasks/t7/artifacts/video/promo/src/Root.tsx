import React from 'react';
import { Composition } from 'remotion';
import { ZhiJianPromo, TOTAL, FPS } from './zjpromo/ZhiJianPromo';

export const Root: React.FC = () => {
  return (
    <Composition
      id="ZhiJianPromo"
      component={ZhiJianPromo}
      durationInFrames={TOTAL}
      fps={FPS}
      width={1280}
      height={720}
    />
  );
};
