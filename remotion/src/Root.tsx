import React from "react";
import { Composition } from "remotion";
import { Slideshow, getTotalDurationInFrames } from "./Slideshow";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="OllamaBrahDemo"
        component={Slideshow}
        durationInFrames={getTotalDurationInFrames()}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
