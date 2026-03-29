import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

export type KenBurnsType = "zoom-in" | "zoom-out" | "pan-left" | "pan-right";

interface SlideSceneProps {
  screenshotIndex: number; // 1-based
  label: string;
  kenBurns: KenBurnsType;
}

function getKenBurnsTransform(
  frame: number,
  durationInFrames: number,
  type: KenBurnsType
): string {
  const p = frame / durationInFrames;
  switch (type) {
    case "zoom-in":
      return `scale(${1 + p * 0.06})`;
    case "zoom-out":
      return `scale(${1.06 - p * 0.06})`;
    case "pan-left":
      return `translateX(${40 - p * 80}px) scale(1.04)`;
    case "pan-right":
      return `translateX(${-40 + p * 80}px) scale(1.04)`;
  }
}

export const SlideScene: React.FC<SlideSceneProps> = ({
  screenshotIndex,
  label,
  kenBurns,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const transform = getKenBurnsTransform(frame, durationInFrames, kenBurns);

  const labelOpacity = interpolate(frame, [8, 28], [0, 1], {
    extrapolateRight: "clamp",
  });
  const labelY = interpolate(frame, [8, 28], [10, 0], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ background: "#0f0f1a", overflow: "hidden" }}>
      {/* Screenshot with Ken Burns */}
      <AbsoluteFill
        style={{
          transform,
          transformOrigin: "center center",
        }}
      >
        <Img
          src={staticFile(`screenshots/Screenshot_${screenshotIndex}.jpg`)}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
          }}
        />
      </AbsoluteFill>

      {/* Vignette */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.5) 100%)",
          pointerEvents: "none",
        }}
      />

      {/* Feature label — bottom left */}
      <div
        style={{
          position: "absolute",
          bottom: 40,
          left: 48,
          opacity: labelOpacity,
          transform: `translateY(${labelY}px)`,
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <div
          style={{
            width: 4,
            height: 22,
            borderRadius: 2,
            background: "linear-gradient(180deg, #818cf8, #c084fc)",
          }}
        />
        <span
          style={{
            fontSize: 24,
            fontWeight: 600,
            color: "rgba(255,255,255,0.9)",
            fontFamily: "system-ui, -apple-system, sans-serif",
            letterSpacing: "0.3px",
            textShadow: "0 1px 8px rgba(0,0,0,0.8)",
          }}
        >
          {label}
        </span>
      </div>
    </AbsoluteFill>
  );
};
