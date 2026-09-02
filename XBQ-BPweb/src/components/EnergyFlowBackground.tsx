import { useId } from "react";
import type { CSSProperties } from "react";

export type EnergyFlowMode = "first" | "second" | "paired" | "idle";

interface EnergyFlowBackgroundProps {
  mode: EnergyFlowMode;
}

interface EnergyFlowStyle extends CSSProperties {
  "--flow-duration"?: string;
  "--flow-delay"?: string;
  "--flow-dash"?: string;
  "--flow-opacity"?: string;
  "--flow-blur"?: string;
  "--flow-travel"?: string;
  "--flow-lift"?: string;
  "--particle-duration"?: string;
  "--particle-delay"?: string;
  "--particle-travel"?: string;
  "--particle-lift"?: string;
}

const streaks = [
  {
    d: "M-20 9C105 1 158 23 286 16C405 9 485 28 635 17C760 8 850 20 1030 15",
    width: 0.72,
    dash: "5 13 16 27",
    duration: "1.35s",
    delay: "-0.9s",
    opacity: "0.72",
    blur: "0px",
    travel: "54px",
    lift: "2px",
  },
  {
    d: "M-10 16C86 25 152 5 260 14C365 24 430 12 565 17",
    width: 1.1,
    dash: "12 24 4 19",
    duration: "1.8s",
    delay: "-1.35s",
    opacity: "0.56",
    blur: "0.2px",
    travel: "42px",
    lift: "-2px",
  },
  {
    d: "M-30 25C92 12 170 37 302 26C430 15 525 39 708 25C820 17 905 24 1110 23",
    width: 0.48,
    dash: "3 10 9 31",
    duration: "1.2s",
    delay: "-0.4s",
    opacity: "0.82",
    blur: "0px",
    travel: "72px",
    lift: "1px",
  },
  {
    d: "M35 31C130 43 215 19 326 29C425 38 490 27 655 33",
    width: 1.45,
    dash: "18 35 5 42",
    duration: "2.35s",
    delay: "-1.1s",
    opacity: "0.38",
    blur: "0.65px",
    travel: "34px",
    lift: "3px",
  },
  {
    d: "M-20 36C82 28 145 54 270 40C382 27 470 47 610 38C715 31 785 39 900 36",
    width: 0.82,
    dash: "7 18 21 44",
    duration: "1.58s",
    delay: "-0.2s",
    opacity: "0.64",
    blur: "0.15px",
    travel: "58px",
    lift: "-1px",
  },
  {
    d: "M-25 43C110 57 190 29 325 43C455 57 560 35 748 45C840 50 930 40 1080 43",
    width: 0.38,
    dash: "2 8 13 24",
    duration: "1.15s",
    delay: "-0.76s",
    opacity: "0.78",
    blur: "0px",
    travel: "86px",
    lift: "-2px",
  },
  {
    d: "M20 50C118 38 182 63 296 51C405 40 470 59 590 50",
    width: 1.25,
    dash: "9 31 17 52",
    duration: "2.05s",
    delay: "-1.74s",
    opacity: "0.4",
    blur: "0.55px",
    travel: "38px",
    lift: "2px",
  },
  {
    d: "M-15 57C76 48 132 68 240 58C350 48 422 63 520 57C610 51 665 56 760 55",
    width: 0.62,
    dash: "4 14 8 38",
    duration: "1.42s",
    delay: "-0.62s",
    opacity: "0.58",
    blur: "0.12px",
    travel: "66px",
    lift: "-3px",
  },
  {
    d: "M70 6C155 18 226 1 310 10C392 19 458 8 552 12",
    width: 0.34,
    dash: "2 7 6 28",
    duration: "1.28s",
    delay: "-1.02s",
    opacity: "0.7",
    blur: "0px",
    travel: "70px",
    lift: "1px",
  },
  {
    d: "M120 21C208 10 272 31 370 22C438 16 492 22 560 20",
    width: 0.9,
    dash: "10 38 3 26",
    duration: "1.92s",
    delay: "-0.33s",
    opacity: "0.44",
    blur: "0.35px",
    travel: "46px",
    lift: "-2px",
  },
  {
    d: "M-10 64C84 52 128 70 226 63C306 57 356 65 450 61",
    width: 0.42,
    dash: "2 12 15 35",
    duration: "1.5s",
    delay: "-1.22s",
    opacity: "0.52",
    blur: "0px",
    travel: "62px",
    lift: "-1px",
  },
  {
    d: "M210 34C296 26 344 45 430 36C502 29 555 39 650 34",
    width: 0.3,
    dash: "4 9 11 40",
    duration: "1.24s",
    delay: "-0.55s",
    opacity: "0.66",
    blur: "0px",
    travel: "78px",
    lift: "2px",
  },
] as const;

const particles = [
  {
    x: 48,
    y: 13,
    length: 13,
    duration: "1.1s",
    delay: "-0.3s",
    travel: "210px",
    lift: "-3px",
  },
  {
    x: 92,
    y: 28,
    length: 7,
    duration: "1.45s",
    delay: "-1.1s",
    travel: "280px",
    lift: "2px",
  },
  {
    x: 35,
    y: 48,
    length: 18,
    duration: "1.25s",
    delay: "-0.72s",
    travel: "235px",
    lift: "-2px",
  },
  {
    x: 160,
    y: 8,
    length: 5,
    duration: "1.7s",
    delay: "-0.9s",
    travel: "330px",
    lift: "3px",
  },
  {
    x: 125,
    y: 57,
    length: 10,
    duration: "1.32s",
    delay: "-0.18s",
    travel: "260px",
    lift: "-3px",
  },
  {
    x: 230,
    y: 39,
    length: 6,
    duration: "1.58s",
    delay: "-1.3s",
    travel: "300px",
    lift: "1px",
  },
] as const;

interface FlowIds {
  ambient: string;
  ribbon: string;
  streak: string;
  highlight: string;
  fluid: string;
  softGlow: string;
}

function EnergySource({ ids }: { ids: FlowIds }) {
  return (
    <g className="energy-flow__source-content">
      <ellipse
        className="energy-flow__ambient"
        cx="20"
        cy="34"
        rx="440"
        ry="62"
        fill={`url(#${ids.ambient})`}
        filter={`url(#${ids.softGlow})`}
      />

      <g className="energy-flow__ribbons" filter={`url(#${ids.fluid})`}>
        <path
          className="energy-flow__ribbon energy-flow__ribbon--primary"
          d="M-30 7C80-2 135 17 225 12C315 7 355 27 445 19C540 10 610 3 700 14C790 27 850 12 1000 18C870 25 805 25 705 22C605 19 540 31 440 29C335 27 280 19 215 24C120 32 48 20-30 33Z"
          fill={`url(#${ids.ribbon})`}
        />
        <path
          className="energy-flow__ribbon energy-flow__ribbon--secondary"
          d="M-30 35C80 27 130 50 220 43C310 36 360 58 455 47C550 35 620 42 790 43C675 50 610 48 515 56C420 64 340 50 245 56C145 65 68 50-30 62Z"
          fill={`url(#${ids.ribbon})`}
        />
        <path
          className="energy-flow__ribbon energy-flow__ribbon--branch"
          d="M10 1C95-4 155 12 240 8C325 4 360 20 445 14C520 8 585 9 680 16C590 17 520 15 440 20C355 25 300 13 225 16C140 20 78 9 10 15Z"
          fill={`url(#${ids.ribbon})`}
        />
      </g>

      <g className="energy-flow__streaks">
        {streaks.map((streak, index) => (
          <path
            key={index}
            className="energy-flow__streak"
            d={streak.d}
            pathLength="100"
            fill="none"
            stroke={`url(#${ids.streak})`}
            strokeWidth={streak.width}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            style={
              {
                "--flow-duration": streak.duration,
                "--flow-delay": streak.delay,
                "--flow-dash": streak.dash,
                "--flow-opacity": streak.opacity,
                "--flow-blur": streak.blur,
                "--flow-travel": streak.travel,
                "--flow-lift": streak.lift,
              } as EnergyFlowStyle
            }
          />
        ))}
      </g>

      <g className="energy-flow__highlights" filter={`url(#${ids.highlight})`}>
        <path
          className="energy-flow__highlight energy-flow__highlight--primary"
          d="M-10 20C125 7 220 31 360 20C500 9 610 30 820 19"
          pathLength="100"
          fill="none"
          stroke="var(--prompt-accent-hot)"
          strokeWidth="1.55"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        <path
          className="energy-flow__highlight energy-flow__highlight--secondary"
          d="M5 49C115 36 215 62 335 49C445 37 535 55 690 47"
          pathLength="100"
          fill="none"
          stroke="var(--prompt-accent-hot)"
          strokeWidth="1.05"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        <path
          className="energy-flow__highlight energy-flow__highlight--branch"
          d="M55 8C145 18 220 2 310 11C390 19 448 8 560 13"
          pathLength="100"
          fill="none"
          stroke="var(--prompt-accent-hot)"
          strokeWidth="0.72"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </g>

      <g className="energy-flow__particles">
        {particles.map((particle, index) => (
          <line
            key={index}
            className="energy-flow__particle"
            x1={particle.x}
            y1={particle.y}
            x2={particle.x + particle.length}
            y2={particle.y}
            stroke="var(--prompt-accent-hot)"
            strokeWidth={index % 3 === 0 ? 0.8 : 0.45}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            style={
              {
                "--particle-duration": particle.duration,
                "--particle-delay": particle.delay,
                "--particle-travel": particle.travel,
                "--particle-lift": particle.lift,
              } as EnergyFlowStyle
            }
          />
        ))}
      </g>
    </g>
  );
}

export function EnergyFlowBackground({ mode }: EnergyFlowBackgroundProps) {
  const id = useId().replace(/:/g, "");
  const ids: FlowIds = {
    ambient: `${id}-energy-ambient`,
    ribbon: `${id}-energy-ribbon`,
    streak: `${id}-energy-streak`,
    highlight: `${id}-energy-highlight-glow`,
    fluid: `${id}-energy-fluid`,
    softGlow: `${id}-energy-soft-glow`,
  };

  return (
    <svg
      className={`energy-flow energy-flow--${mode}`}
      viewBox="0 0 1200 68"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id={ids.ambient} cx="0" cy="0.5" r="0.95">
          <stop
            offset="0"
            stopColor="var(--prompt-accent-mid)"
            stopOpacity="0.34"
          />
          <stop
            offset="0.36"
            stopColor="var(--prompt-accent-deep)"
            stopOpacity="0.2"
          />
          <stop
            offset="1"
            stopColor="var(--prompt-accent-deep)"
            stopOpacity="0"
          />
        </radialGradient>
        <linearGradient
          id={ids.ribbon}
          x1="0"
          y1="0"
          x2="1000"
          y2="0"
          gradientUnits="userSpaceOnUse"
        >
          <stop
            offset="0"
            stopColor="var(--prompt-accent-hot)"
            stopOpacity="0.58"
          />
          <stop
            offset="0.18"
            stopColor="var(--prompt-accent)"
            stopOpacity="0.48"
          />
          <stop
            offset="0.52"
            stopColor="var(--prompt-accent-mid)"
            stopOpacity="0.24"
          />
          <stop
            offset="0.82"
            stopColor="var(--prompt-accent-deep)"
            stopOpacity="0.08"
          />
          <stop
            offset="1"
            stopColor="var(--prompt-accent-deep)"
            stopOpacity="0"
          />
        </linearGradient>
        <linearGradient
          id={ids.streak}
          x1="0"
          y1="0"
          x2="1050"
          y2="0"
          gradientUnits="userSpaceOnUse"
        >
          <stop
            offset="0"
            stopColor="var(--prompt-accent-hot)"
            stopOpacity="0.9"
          />
          <stop
            offset="0.24"
            stopColor="var(--prompt-accent)"
            stopOpacity="0.72"
          />
          <stop
            offset="0.7"
            stopColor="var(--prompt-accent-mid)"
            stopOpacity="0.3"
          />
          <stop
            offset="1"
            stopColor="var(--prompt-accent-deep)"
            stopOpacity="0"
          />
        </linearGradient>
        <filter id={ids.softGlow} x="-20%" y="-90%" width="150%" height="280%">
          <feGaussianBlur stdDeviation="17" />
        </filter>
        <filter id={ids.fluid} x="-8%" y="-45%" width="118%" height="190%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.006 0.075"
            numOctaves="1"
            seed="9"
            result="flowNoise"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="flowNoise"
            scale="1.25"
            xChannelSelector="R"
            yChannelSelector="B"
          />
        </filter>
        <filter id={ids.highlight} x="-8%" y="-100%" width="120%" height="300%">
          <feGaussianBlur stdDeviation="0.85" result="highlightBlur" />
          <feMerge>
            <feMergeNode in="highlightBlur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <g className="energy-flow__source energy-flow__source--left">
        <EnergySource ids={ids} />
      </g>
      <g
        className="energy-flow__source energy-flow__source--right"
        transform="translate(1200 0) scale(-1 1)"
      >
        <EnergySource ids={ids} />
      </g>
    </svg>
  );
}
