import { useState, useCallback } from "react"

type FeatureIndex = 0 | 1 | 2

type FaceConfig = {
  hair: FeatureIndex
  eyes: FeatureIndex
  nose: FeatureIndex
  mouth: FeatureIndex
}

function randomFace(): FaceConfig {
  return {
    hair: Math.floor(Math.random() * 3) as FeatureIndex,
    eyes: Math.floor(Math.random() * 3) as FeatureIndex,
    nose: Math.floor(Math.random() * 3) as FeatureIndex,
    mouth: Math.floor(Math.random() * 3) as FeatureIndex,
  }
}

// Face is a circle at cx=100 cy=120 r=75, viewBox "0 0 200 215"
// Hair renders BEFORE the face so it appears behind/around it

const HAIR_COLOR = ["#3b2314", "#8b4513", "#1a0a00"] as const
const HAIR: React.ReactNode[] = [
  // 0: Short bowl cut — smooth dome above the face
  <path
    key="h"
    d="M 27 118 Q 28 36 100 34 Q 172 36 173 118 Q 148 68 100 66 Q 52 68 27 118 Z"
    fill={HAIR_COLOR[0]}
  />,

  // 1: Long curtain hair — hangs down both sides
  <g key="h">
    <path
      d="M 28 118 Q 30 36 100 34 Q 170 36 172 118 Q 148 68 100 66 Q 52 68 28 118 Z"
      fill={HAIR_COLOR[1]}
    />
    <path
      d="M 28 118 Q 10 155 14 200 Q 26 178 34 158 Q 44 134 52 118"
      fill={HAIR_COLOR[1]}
    />
    <path
      d="M 172 118 Q 190 155 186 200 Q 174 178 166 158 Q 156 134 148 118"
      fill={HAIR_COLOR[1]}
    />
  </g>,

  // 2: Curly afro — large rounded shape behind the head
  <g key="h">
    <circle cx={100} cy={62} r={52} fill={HAIR_COLOR[2]} />
    <circle cx={57}  cy={82} r={22} fill={HAIR_COLOR[2]} />
    <circle cx={143} cy={82} r={22} fill={HAIR_COLOR[2]} />
    <circle cx={74}  cy={50} r={16} fill={HAIR_COLOR[2]} />
    <circle cx={126} cy={50} r={16} fill={HAIR_COLOR[2]} />
  </g>,
]

const EYES: React.ReactNode[] = [
  // 0: Friendly round eyes with sparkle
  <g key="e">
    <circle cx={78}  cy={104} r={11} fill="white" />
    <circle cx={122} cy={104} r={11} fill="white" />
    <circle cx={79}  cy={105} r={7}  fill="#2a1a0a" />
    <circle cx={123} cy={105} r={7}  fill="#2a1a0a" />
    <circle cx={82}  cy={102} r={2.5} fill="white" />
    <circle cx={126} cy={102} r={2.5} fill="white" />
  </g>,

  // 1: Almond eyes with upper lash line
  <g key="e">
    <ellipse cx={78}  cy={104} rx={13} ry={9}  fill="white" />
    <ellipse cx={122} cy={104} rx={13} ry={9}  fill="white" />
    <ellipse cx={79}  cy={105} rx={9}  ry={8}  fill="#2a1a0a" />
    <ellipse cx={123} cy={105} rx={9}  ry={8}  fill="#2a1a0a" />
    <circle cx={82}  cy={102} r={2.5} fill="white" />
    <circle cx={126} cy={102} r={2.5} fill="white" />
    <path d="M 65 104 Q 78 95 91 104"  fill="none" stroke="#1a0a00" strokeWidth="2" strokeLinecap="round" />
    <path d="M 109 104 Q 122 95 135 104" fill="none" stroke="#1a0a00" strokeWidth="2" strokeLinecap="round" />
  </g>,

  // 2: Sleepy half-lid eyes
  <g key="e">
    <circle cx={78}  cy={106} r={11} fill="white" />
    <circle cx={122} cy={106} r={11} fill="white" />
    <circle cx={79}  cy={108} r={8}  fill="#2a1a0a" />
    <circle cx={123} cy={108} r={8}  fill="#2a1a0a" />
    <circle cx={82}  cy={105} r={2.5} fill="white" />
    <circle cx={126} cy={105} r={2.5} fill="white" />
    {/* droopy upper lids */}
    <path d="M 67 106 Q 78 98 89 106" fill="#f5c5a3" />
    <path d="M 111 106 Q 122 98 133 106" fill="#f5c5a3" />
  </g>,
]

const NOSE: React.ReactNode[] = [
  // 0: Subtle dot
  <circle key="n" cx={100} cy={122} r={4} fill="#d4906a" />,

  // 1: Twin nostrils button nose
  <g key="n">
    <ellipse cx={95}  cy={122} rx={5.5} ry={4} fill="#d4906a" />
    <ellipse cx={105} cy={122} rx={5.5} ry={4} fill="#d4906a" />
  </g>,

  // 2: Upturned ski-slope nose
  <g key="n">
    <path
      d="M 94 113 Q 92 122 96 124 Q 100 126 104 124 Q 108 122 106 113"
      fill="none" stroke="#d4906a" strokeWidth="2.5" strokeLinecap="round"
    />
    <path
      d="M 96 124 Q 100 128 104 124"
      fill="none" stroke="#d4906a" strokeWidth="2" strokeLinecap="round"
    />
  </g>,
]

const MOUTH: React.ReactNode[] = [
  // 0: Warm smile
  <path
    key="m"
    d="M 78 142 Q 100 162 122 142"
    fill="none" stroke="#c0705a" strokeWidth="3.5" strokeLinecap="round"
  />,

  // 1: Big open grin with teeth
  <g key="m">
    <path d="M 74 140 Q 100 168 126 140 Z" fill="#c0705a" />
    <path d="M 74 140 Q 100 155 126 140" fill="white" />
    <line x1="87"  y1="141" x2="87"  y2="151" stroke="#e0a090" strokeWidth="1.5" />
    <line x1="100" y1="141" x2="100" y2="153" stroke="#e0a090" strokeWidth="1.5" />
    <line x1="113" y1="141" x2="113" y2="151" stroke="#e0a090" strokeWidth="1.5" />
  </g>,

  // 2: Chill neutral line
  <path
    key="m"
    d="M 83 145 Q 100 143 117 145"
    fill="none" stroke="#c0705a" strokeWidth="3" strokeLinecap="round"
  />,
]

function FaceSVG({ config }: { config: FaceConfig }) {
  return (
    <svg viewBox="0 0 200 215" xmlns="http://www.w3.org/2000/svg" className="w-full h-full drop-shadow-lg">
      {/* Hair — behind everything */}
      {HAIR[config.hair]}
      {/* Face base */}
      <circle cx={100} cy={120} r={75} fill="#f5c5a3" />
      {/* Rosy cheeks */}
      <circle cx={64}  cy={132} r={13} fill="#f09070" opacity={0.35} />
      <circle cx={136} cy={132} r={13} fill="#f09070" opacity={0.35} />
      {/* Features */}
      {EYES[config.eyes]}
      {NOSE[config.nose]}
      {MOUTH[config.mouth]}
    </svg>
  )
}

const FEATURE_LABELS: Record<keyof FaceConfig, string> = {
  hair: "Hair",
  eyes: "Eyes",
  nose: "Nose",
  mouth: "Mouth",
}

const FEATURE_OPTIONS: Record<keyof FaceConfig, [string, string, string]> = {
  hair:  ["Bowl",    "Long",    "Afro"],
  eyes:  ["Round",   "Almond",  "Sleepy"],
  nose:  ["Dot",     "Button",  "Ski-tip"],
  mouth: ["Smile",   "Grin",    "Chill"],
}

export function FaceGenerator() {
  const [config, setConfig] = useState<FaceConfig>(randomFace)

  const handleRandomize = useCallback(() => setConfig(randomFace()), [])

  const setFeature = useCallback(
    (feature: keyof FaceConfig, value: FeatureIndex) =>
      setConfig(prev => ({ ...prev, [feature]: value })),
    []
  )

  return (
    <div className="bg-panel rounded-2xl p-6">
      <h2 className="text-white font-semibold mb-5 text-sm tracking-wide uppercase opacity-70">
        Random Face Generator
      </h2>

      <div className="flex flex-col items-center gap-5">
        {/* Face preview */}
        <div className="w-44 h-44">
          <FaceSVG config={config} />
        </div>

        {/* Feature toggles */}
        <div className="w-full grid grid-cols-4 gap-3">
          {(Object.keys(FEATURE_LABELS) as (keyof FaceConfig)[]).map(feature => (
            <div key={feature} className="flex flex-col items-center gap-2">
              <span className="text-muted text-xs">{FEATURE_LABELS[feature]}</span>
              <div className="flex flex-col gap-1 w-full">
                {([0, 1, 2] as FeatureIndex[]).map(i => (
                  <button
                    key={i}
                    onClick={() => setFeature(feature, i)}
                    className={`text-xs py-1 px-1 rounded-lg transition-colors truncate ${
                      config[feature] === i
                        ? "bg-accent text-white font-semibold"
                        : "bg-surface text-muted hover:text-white hover:bg-border"
                    }`}
                  >
                    {FEATURE_OPTIONS[feature][i]}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Randomize button */}
        <button
          onClick={handleRandomize}
          className="w-full bg-accent hover:bg-accent-hover text-white font-semibold py-2.5 rounded-xl transition-colors text-sm"
        >
          Randomize
        </button>
      </div>
    </div>
  )
}
