import React from 'react';
import {Composition} from 'remotion';
import {RentalSafety} from './RentalSafety';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="RentalSafety"
      component={RentalSafety}
      durationInFrames={1740}
      fps={30}
      width={1280}
      height={720}
    />
  );
};
