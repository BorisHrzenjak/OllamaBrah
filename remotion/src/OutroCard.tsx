import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

export const OutroCard: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const nameScale = spring({
    frame,
    fps,
    config: { damping: 16, stiffness: 90, mass: 1 },
    durationInFrames: 40,
  });

  const nameOpacity = interpolate(frame, [0, 18], [0, 1], {
    extrapolateRight: "clamp",
  });

  const taglineOpacity = interpolate(frame, [25, 48], [0, 1], {
    extrapolateRight: "clamp",
  });

  const taglineY = interpolate(frame, [25, 48], [14, 0], {
    extrapolateRight: "clamp",
  });

  const dividerScaleX = interpolate(frame, [20, 45], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background: "linear-gradient(135deg, #0f0f1a 0%, #1a1a2e 50%, #16213e 100%)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 28,
      }}
    >
      {/* Glow */}
      <div
        style={{
          position: "absolute",
          width: 500,
          height: 500,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(99,102,241,0.12) 0%, transparent 70%)",
          pointerEvents: "none",
        }}
      />

      {/* App name */}
      <div
        style={{
          opacity: nameOpacity,
          transform: `scale(${nameScale})`,
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        <span
          style={{
            fontSize: 96,
            fontWeight: 800,
            color: "#ffffff",
            fontFamily: "system-ui, -apple-system, sans-serif",
            letterSpacing: "-2px",
            lineHeight: 1,
          }}
        >
          Ollama
        </span>
        <span
          style={{
            fontSize: 96,
            fontWeight: 800,
            background: "linear-gradient(90deg, #818cf8, #c084fc)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            fontFamily: "system-ui, -apple-system, sans-serif",
            letterSpacing: "-2px",
            lineHeight: 1,
          }}
        >
          Brah
        </span>
      </div>

      {/* Divider line */}
      <div
        style={{
          width: 280,
          height: 1,
          background: "linear-gradient(90deg, transparent, rgba(129,140,248,0.5), transparent)",
          transform: `scaleX(${dividerScaleX})`,
          transformOrigin: "center",
        }}
      />

      {/* Tagline */}
      <div
        style={{
          opacity: taglineOpacity,
          transform: `translateY(${taglineY}px)`,
          fontSize: 30,
          color: "rgba(255,255,255,0.55)",
          fontFamily: "system-ui, -apple-system, sans-serif",
          fontWeight: 400,
          letterSpacing: "0.5px",
        }}
      >
        Your AI. Your machine.
      </div>
    </AbsoluteFill>
  );
};
