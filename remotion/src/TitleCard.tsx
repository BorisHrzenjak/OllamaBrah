import React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
  spring,
} from "remotion";

export const TitleCard: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleScale = spring({
    frame,
    fps,
    config: { damping: 14, stiffness: 80, mass: 1 },
    durationInFrames: 45,
  });

  const titleOpacity = interpolate(frame, [0, 20], [0, 1], {
    extrapolateRight: "clamp",
  });

  const subtitleOpacity = interpolate(frame, [30, 55], [0, 1], {
    extrapolateRight: "clamp",
  });

  const subtitleY = interpolate(frame, [30, 55], [20, 0], {
    extrapolateRight: "clamp",
  });

  const taglineOpacity = interpolate(frame, [50, 75], [0, 1], {
    extrapolateRight: "clamp",
  });

  const taglineY = interpolate(frame, [50, 75], [20, 0], {
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
        gap: 24,
      }}
    >
      {/* Glow background circle */}
      <div
        style={{
          position: "absolute",
          width: 600,
          height: 600,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(99,102,241,0.15) 0%, transparent 70%)",
          pointerEvents: "none",
        }}
      />

      {/* App name */}
      <div
        style={{
          opacity: titleOpacity,
          transform: `scale(${titleScale})`,
          display: "flex",
          alignItems: "center",
          gap: 20,
        }}
      >
        <span
          style={{
            fontSize: 110,
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
            fontSize: 110,
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

      {/* Subtitle */}
      <div
        style={{
          opacity: subtitleOpacity,
          transform: `translateY(${subtitleY}px)`,
          fontSize: 36,
          color: "rgba(255,255,255,0.65)",
          fontFamily: "system-ui, -apple-system, sans-serif",
          fontWeight: 400,
          letterSpacing: "0.5px",
        }}
      >
        Your local AI chat companion
      </div>

      {/* Tagline / badge */}
      <div
        style={{
          opacity: taglineOpacity,
          transform: `translateY(${taglineY}px)`,
          display: "flex",
          gap: 16,
          marginTop: 12,
        }}
      >
        {["Electron", "Ollama", "Local AI"].map((tag) => (
          <div
            key={tag}
            style={{
              padding: "8px 24px",
              borderRadius: 100,
              border: "1px solid rgba(129,140,248,0.4)",
              color: "rgba(165,180,252,0.9)",
              fontSize: 22,
              fontFamily: "system-ui, -apple-system, sans-serif",
              fontWeight: 500,
              background: "rgba(99,102,241,0.08)",
            }}
          >
            {tag}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};
