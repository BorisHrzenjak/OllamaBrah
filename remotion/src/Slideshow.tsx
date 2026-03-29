import React from "react";
import {
  AbsoluteFill,
  Audio,
  interpolate,
  staticFile,
  useCurrentFrame,
  Sequence,
} from "remotion";
import { TitleCard } from "./TitleCard";
import { SlideScene, KenBurnsType } from "./SlideScene";
import { OutroCard } from "./OutroCard";

// ─── Timing ──────────────────────────────────────────────────────────────────
const TITLE_DURATION = 75;   // 2.5s
const SLIDE_DURATION = 80;   // ~2.67s per screenshot
const FADE_DURATION  = 12;   // 0.4s crossfade overlap
const OUTRO_DURATION = 90;   // 3s end card

const TOTAL_SLIDES = 19;

function slideStartFrame(index: number): number {
  return TITLE_DURATION + index * (SLIDE_DURATION - FADE_DURATION);
}

const OUTRO_START = slideStartFrame(TOTAL_SLIDES); // 1367

export function getTotalDurationInFrames(): number {
  return OUTRO_START + OUTRO_DURATION; // 1457 ≈ 48.6s
}

// ─── Slide data ───────────────────────────────────────────────────────────────
// Screenshots are already in a logical order:
//   Chat → Dashboard → Personalization → Model config → Advanced
const KEN_BURNS_CYCLE: KenBurnsType[] = [
  "zoom-in", "zoom-out", "pan-right", "pan-left",
];

const SLIDE_LABELS: string[] = [
  "Chat with Local & Cloud Models",   // 1
  "Real-time Token Tracking",         // 2
  "Conversation Search",              // 3
  "Instant Model Switching",          // 4
  "Usage Dashboard",                  // 5
  "15+ Themes",                       // 6
  "Persona Presets",                  // 7
  "Prompt Templates",                 // 8
  "Built-in Skills",                  // 9
  "System Prompt",                    // 10
  "Model Parameters",                 // 11
  "Model Management",                 // 12
  "Hardware-Aware Model Browser",     // 13
  "Context Window",                   // 14
  "llama.cpp Integration",            // 15
  "Agent Mode",                       // 16
  "Semantic Memory",                  // 17
  "Text-to-Speech",                   // 18
  "API Keys & Web Search",            // 19
];

// ─── Crossfade wrapper ────────────────────────────────────────────────────────
const FadeWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, FADE_DURATION], [0, 1], {
    extrapolateRight: "clamp",
  });
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
};

// ─── Main composition ─────────────────────────────────────────────────────────
export const Slideshow: React.FC = () => {
  const total = getTotalDurationInFrames();

  return (
    <AbsoluteFill style={{ background: "#0f0f1a" }}>
      {/* Background music — fades out over last 40 frames */}
      <Audio
        src={staticFile("background.mp3")}
        volume={(f) =>
          interpolate(f, [total - 40, total], [0.2, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })
        }
      />

      {/* Voiceover — starts at 3s 10f (frame 100) */}
      <Sequence from={100}>
        <Audio src={staticFile("voiceover.mp3")} volume={1} />
      </Sequence>

      {/* Title card */}
      <Sequence from={0} durationInFrames={TITLE_DURATION + FADE_DURATION}>
        <FadeWrapper>
          <TitleCard />
        </FadeWrapper>
      </Sequence>

      {/* Screenshot slides */}
      {Array.from({ length: TOTAL_SLIDES }, (_, i) => (
        <Sequence
          key={i}
          from={slideStartFrame(i)}
          durationInFrames={SLIDE_DURATION + FADE_DURATION}
        >
          <FadeWrapper>
            <SlideScene
              screenshotIndex={i + 1}
              label={SLIDE_LABELS[i]}
              kenBurns={KEN_BURNS_CYCLE[i % KEN_BURNS_CYCLE.length]}
            />
          </FadeWrapper>
        </Sequence>
      ))}

      {/* Outro end card */}
      <Sequence from={OUTRO_START} durationInFrames={OUTRO_DURATION}>
        <FadeWrapper>
          <OutroCard />
        </FadeWrapper>
      </Sequence>
    </AbsoluteFill>
  );
};
