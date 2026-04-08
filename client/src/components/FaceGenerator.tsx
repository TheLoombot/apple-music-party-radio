import { useState, useCallback, useMemo } from "react"

// ─── Types ────────────────────────────────────────────────────────────────────

export type FaceConfig = {
  hair:       number  // 0-5
  eyes:       number  // 0-2
  brows:      number  // 0-2
  nose:       number  // 0-2
  mouth:      number  // 0-2
  glasses:    number  // 0-3
  bgColor:    number
  skinTone:   number
  hairColor:  number
  eyeColor:   number
  shirtColor: number
}

// ─── Palettes ─────────────────────────────────────────────────────────────────

const BG_PALETTE = [
  { color: "#FF6B6B", label: "Coral"   },
  { color: "#4ECDC4", label: "Teal"    },
  { color: "#A78BFA", label: "Violet"  },
  { color: "#60A5FA", label: "Blue"    },
  { color: "#34D399", label: "Emerald" },
  { color: "#FBBF24", label: "Amber"   },
  { color: "#F472B6", label: "Pink"    },
  { color: "#818CF8", label: "Indigo"  },
  { color: "#6EE7B7", label: "Mint"    },
  { color: "#94A3B8", label: "Slate"   },
] as const

const SKIN_PALETTES = [
  { face: "#f5d0b0", cheek: "#f0a070", nose: "#d89060", lid: "#f5d0b0", mouth: "#c86850", hi: "#e09080" },
  { face: "#d4956b", cheek: "#c07050", nose: "#b46840", lid: "#d4956b", mouth: "#9e5038", hi: "#bf7858" },
  { face: "#8b5524", cheek: "#784010", nose: "#6a3c14", lid: "#8b5524", mouth: "#5c2c10", hi: "#a06838" },
  { face: "#4a2912", cheek: "#3a1808", nose: "#3a2010", lid: "#4a2912", mouth: "#2e1408", hi: "#5a3820" },
] as const

const HAIR_PALETTE = [
  { color: "#111111", label: "Black"  },
  { color: "#3b2314", label: "Brown"  },
  { color: "#8b4513", label: "Auburn" },
  { color: "#c8a850", label: "Blonde" },
  { color: "#b83418", label: "Red"    },
  { color: "#8a8a8a", label: "Gray"   },
  { color: "#e8e0d0", label: "White"  },
  { color: "#2a7a6a", label: "Teal"   },
  { color: "#6a2a8a", label: "Purple" },
] as const

const EYE_PALETTE = [
  { color: "#2a1a0a", label: "Brown"  },
  { color: "#1a4a7a", label: "Blue"   },
  { color: "#1a5020", label: "Green"  },
  { color: "#6a4820", label: "Hazel"  },
  { color: "#507080", label: "Gray"   },
  { color: "#7a2a6a", label: "Violet" },
] as const

const SHIRT_PALETTE = [
  { color: "#2563EB", label: "Blue"   },
  { color: "#DC2626", label: "Red"    },
  { color: "#059669", label: "Green"  },
  { color: "#7C3AED", label: "Purple" },
  { color: "#D97706", label: "Orange" },
  { color: "#DB2777", label: "Pink"   },
  { color: "#4B5563", label: "Gray"   },
  { color: "#111827", label: "Black"  },
] as const

// ─── Helpers ──────────────────────────────────────────────────────────────────

const rand = (n: number) => Math.floor(Math.random() * n)

// ─── Coordinated palettes ─────────────────────────────────────────────────────
// Each palette defines a skin tone + 4 indices (0-5, valid in all color palettes).
// On randomize: pick a palette, Fisher-Yates shuffle the 4 indices, then assign
// them to [bgColor, hairColor, eyeColor, shirtColor].
// 10 palettes × 24 permutations = 240 coordinated color combos.

type CoordPalette = { skin: number; c: [number, number, number, number] }

const COORD_PALETTES: CoordPalette[] = [
  { skin: 0, c: [0, 2, 1, 4] },  // warm: coral / auburn / blue / orange
  { skin: 1, c: [1, 3, 0, 5] },  // ocean: teal / blonde / black / pink
  { skin: 2, c: [4, 1, 2, 3] },  // forest: emerald / brown / green / purple
  { skin: 0, c: [2, 5, 4, 3] },  // violet: violet / gray / gray / purple
  { skin: 3, c: [0, 4, 2, 1] },  // dark warm: coral / red / green / red
  { skin: 1, c: [5, 3, 0, 2] },  // golden: amber / blonde / brown / green
  { skin: 0, c: [3, 4, 2, 5] },  // rose: blue / red / green / pink
  { skin: 0, c: [4, 0, 3, 2] },  // fresh: emerald / black / hazel / green
  { skin: 2, c: [1, 5, 4, 0] },  // earth: teal / gray / gray / blue
  { skin: 1, c: [3, 2, 5, 1] },  // electric: blue / auburn / violet / red
]

function randomFace(): FaceConfig {
  const palette = COORD_PALETTES[rand(COORD_PALETTES.length)]
  const c: [number, number, number, number] = [...palette.c] as [number, number, number, number]
  // Fisher-Yates shuffle the 4 swappable color indices
  for (let i = 3; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [c[i], c[j]] = [c[j], c[i]]
  }
  const g = Math.random()
  return {
    hair:       rand(6),
    eyes:       rand(3),
    brows:      rand(3),
    nose:       rand(3),
    mouth:      rand(3),
    glasses:    g < 0.70 ? 0 : g < 0.80 ? 1 : g < 0.90 ? 2 : 3,
    bgColor:    c[0],
    skinTone:   palette.skin,
    hairColor:  c[1],
    eyeColor:   c[2],
    shirtColor: c[3],
  }
}

// ─── SVG layout ───────────────────────────────────────────────────────────────
// viewBox:   0 0 200 220
// face:      cx=100 cy=118 r=68   (bottom edge y=186)
// eyes:      cx=76/124  cy=108
// brows:     y≈91
// nose:      cy≈127
// mouth:     y≈143
// ears:      cx=27/173  cy=116
// neck:      x=87–113   y=182–200
// shirt:     y=188–220

function renderHair(style: number, color: string): React.ReactNode {
  switch (style) {
    case 0: // Buzz — thin skullcap close to head
      return (
        <path key="h"
          d="M 50 104 Q 52 38 100 36 Q 148 38 150 104 Q 132 68 100 66 Q 68 68 50 104 Z"
          fill={color} />
      )
    case 1: // Bob — cap + short side curtains ending at jaw, face circle cuts the middle
      return (
        <g key="h">
          <path d="M 26 118 Q 26 28 100 26 Q 174 28 174 118 Q 154 68 100 66 Q 46 68 26 118 Z" fill={color} />
          <path d="M 26 118 Q 10 150 12 192 Q 26 200 44 192 Q 50 162 50 118 Z" fill={color} />
          <path d="M 174 118 Q 190 150 188 192 Q 174 200 156 192 Q 150 162 150 118 Z" fill={color} />
        </g>
      )
    case 2: // Long — wide flowing curtains, not pigtails
      return (
        <g key="h">
          <path d="M 32 114 Q 32 34 100 32 Q 168 34 168 114 Q 148 68 100 66 Q 52 68 32 114 Z" fill={color} />
          <path d="M 32 114 Q 14 152 16 220 L 56 220 Q 52 164 52 114 Z" fill={color} />
          <path d="M 168 114 Q 186 152 184 220 L 144 220 Q 148 164 148 114 Z" fill={color} />
        </g>
      )
    case 3: // Afro
      return (
        <g key="h">
          <circle cx={100} cy={64}  r={62} fill={color} />
          <circle cx={44}  cy={88}  r={28} fill={color} />
          <circle cx={156} cy={88}  r={28} fill={color} />
          <circle cx={60}  cy={48}  r={20} fill={color} />
          <circle cx={140} cy={48}  r={20} fill={color} />
        </g>
      )
    case 4: // Mohawk spike
      return (
        <path key="h"
          d="M 86 116 Q 88 62 96 34 Q 100 26 104 34 Q 112 62 114 116 Q 106 80 100 78 Q 94 80 86 116 Z"
          fill={color} />
      )
    default: // Bun / topknot
      return (
        <g key="h">
          <path d="M 52 108 Q 54 54 100 52 Q 146 54 148 108 Q 130 76 100 74 Q 70 76 52 108 Z" fill={color} />
          <ellipse cx={100} cy={54} rx={14} ry={10} fill={color} />
          <circle  cx={100} cy={36} r={20}           fill={color} />
        </g>
      )
  }
}


function renderEyes(style: number, irisColor: string): React.ReactNode {
  switch (style) {
    case 0: // Lash-arc — iris circle with bold curved top lash sitting over it
      return (
        <g key="e">
          <circle cx={76}  cy={111} r={9}   fill={irisColor} />
          <circle cx={124} cy={111} r={9}   fill={irisColor} />
          <circle cx={76}  cy={111} r={4.5} fill="#111" />
          <circle cx={124} cy={111} r={4.5} fill="#111" />
          <path d="M 63 111 Q 76 99 89 111"    fill="none" stroke="#111" strokeWidth={4.5} strokeLinecap="round" />
          <path d="M 111 111 Q 124 99 137 111" fill="none" stroke="#111" strokeWidth={4.5} strokeLinecap="round" />
        </g>
      )
    case 1: // Oval — flat horizontal ellipse, outline + iris dot inside
      return (
        <g key="e">
          <ellipse cx={76}  cy={108} rx={14} ry={9} fill="white" stroke="#111" strokeWidth={3} />
          <ellipse cx={124} cy={108} rx={14} ry={9} fill="white" stroke="#111" strokeWidth={3} />
          <circle  cx={76}  cy={108} r={6}   fill={irisColor} />
          <circle  cx={124} cy={108} r={6}   fill={irisColor} />
          <circle  cx={76}  cy={108} r={3}   fill="#111" />
          <circle  cx={124} cy={108} r={3}   fill="#111" />
        </g>
      )
    default: // Dot — two solid circles, nothing else
      return (
        <g key="e">
          <circle cx={76}  cy={108} r={10} fill={irisColor} />
          <circle cx={124} cy={108} r={10} fill={irisColor} />
          <circle cx={76}  cy={108} r={5}  fill="#111" />
          <circle cx={124} cy={108} r={5}  fill="#111" />
        </g>
      )
  }
}

function renderBrows(style: number, hairColor: string): React.ReactNode {
  // Very light hair gets a mid-tone brow so it still reads
  const c = hairColor === "#e8e0d0" ? "#888880" : hairColor
  switch (style) {
    case 0: // Flat neutral
      return (
        <g key="b">
          <path d="M 62 91 L 90 91"   stroke={c} strokeWidth={4.5} strokeLinecap="round" />
          <path d="M 110 91 L 138 91" stroke={c} strokeWidth={4.5} strokeLinecap="round" />
        </g>
      )
    case 1: // Arched friendly
      return (
        <g key="b">
          <path d="M 61 95 Q 76 82 91 93"    stroke={c} strokeWidth={4.5} strokeLinecap="round" fill="none" />
          <path d="M 109 93 Q 124 82 139 95" stroke={c} strokeWidth={4.5} strokeLinecap="round" fill="none" />
        </g>
      )
    default: // Bold angled / expressive
      return (
        <g key="b">
          <path d="M 61 93 Q 76 84 91 90"    stroke={c} strokeWidth={6} strokeLinecap="round" fill="none" />
          <path d="M 109 90 Q 124 84 139 93" stroke={c} strokeWidth={6} strokeLinecap="round" fill="none" />
        </g>
      )
  }
}

function renderNose(style: number, color: string): React.ReactNode {
  switch (style) {
    case 0: // Arch — upside-down U, just the bridge (∩)
      return (
        <path key="n" d="M 93 130 Q 100 119 107 130"
          fill="none" stroke={color} strokeWidth={3.5} strokeLinecap="round" />
      )
    case 1: // U-shape — open top, rounded bottom (∪)
      return (
        <path key="n" d="M 94 119 Q 93 132 100 134 Q 107 132 106 119"
          fill="none" stroke={color} strokeWidth={3.5} strokeLinecap="round" />
      )
    default: // Nostrils — W curve showing nostril tips
      return (
        <path key="n" d="M 91 126 Q 94 133 100 130 Q 106 133 109 126"
          fill="none" stroke={color} strokeWidth={3.5} strokeLinecap="round" />
      )
  }
}

function renderMouth(style: number, color: string, hi: string): React.ReactNode {
  switch (style) {
    case 0: // Big smile
      return (
        <path key="m" d="M 74 140 Q 100 166 126 140"
          fill="none" stroke={color} strokeWidth={5} strokeLinecap="round" />
      )
    case 1: // Open grin with teeth
      return (
        <g key="m">
          <path d="M 70 138 Q 100 170 130 138 Z" fill={color} />
          <path d="M 70 138 Q 100 153 130 138"   fill="white" />
          <line x1={86}  y1={139} x2={86}  y2={150} stroke={hi} strokeWidth={1.5} />
          <line x1={100} y1={139} x2={100} y2={153} stroke={hi} strokeWidth={1.5} />
          <line x1={114} y1={139} x2={114} y2={150} stroke={hi} strokeWidth={1.5} />
        </g>
      )
    default: // Smirk / neutral
      return (
        <path key="m" d="M 80 143 Q 100 140 122 147"
          fill="none" stroke={color} strokeWidth={4.5} strokeLinecap="round" />
      )
  }
}

function renderGlasses(style: number): React.ReactNode {
  if (style === 0) return null
  const stroke = "#1a1a1a"
  const sw = 2.5
  const clearLens = "rgba(180,220,255,0.18)"
  // Ears are at cx≈27/173 cy≈116 — temple arms run to those points
  if (style === 1) return (  // Round
    <g key="g">
      <circle cx={76}  cy={108} r={17} fill={clearLens} stroke={stroke} strokeWidth={sw} />
      <circle cx={124} cy={108} r={17} fill={clearLens} stroke={stroke} strokeWidth={sw} />
      <line x1={93}  y1={108} x2={107} y2={108} stroke={stroke} strokeWidth={sw} />
      <line x1={59}  y1={105} x2={28}  y2={115} stroke={stroke} strokeWidth={sw} />
      <line x1={141} y1={105} x2={172} y2={115} stroke={stroke} strokeWidth={sw} />
    </g>
  )
  if (style === 2) return (  // Square / rectangular
    <g key="g">
      <rect x={58}  y={97} width={36} height={24} rx={4} fill={clearLens} stroke={stroke} strokeWidth={sw} />
      <rect x={106} y={97} width={36} height={24} rx={4} fill={clearLens} stroke={stroke} strokeWidth={sw} />
      <line x1={94}  y1={109} x2={106} y2={109} stroke={stroke} strokeWidth={sw} />
      <line x1={58}  y1={109} x2={28}  y2={115} stroke={stroke} strokeWidth={sw} />
      <line x1={142} y1={109} x2={172} y2={115} stroke={stroke} strokeWidth={sw} />
    </g>
  )
  // style === 3: Sunglasses — oversized, very dark tint
  const darkLens = "rgba(10,10,20,0.96)"
  return (
    <g key="g">
      <rect x={54}  y={95} width={44} height={28} rx={7} fill={darkLens} stroke={stroke} strokeWidth={sw} />
      <rect x={102} y={95} width={44} height={28} rx={7} fill={darkLens} stroke={stroke} strokeWidth={sw} />
      <line x1={98}  y1={109} x2={102} y2={109} stroke={stroke} strokeWidth={sw} />
      <line x1={54}  y1={109} x2={28}  y2={115} stroke={stroke} strokeWidth={sw} />
      <line x1={146} y1={109} x2={172} y2={115} stroke={stroke} strokeWidth={sw} />
    </g>
  )
}

// ─── Face SVG ─────────────────────────────────────────────────────────────────

export function FaceSVG({ config }: { config: FaceConfig }) {
  const bg    = BG_PALETTE[config.bgColor].color
  const skin  = SKIN_PALETTES[config.skinTone]
  const hair  = HAIR_PALETTE[config.hairColor].color
  const eye   = EYE_PALETTE[config.eyeColor].color
  const shirt = SHIRT_PALETTE[config.shirtColor].color

  return (
    <svg viewBox="0 0 200 220" xmlns="http://www.w3.org/2000/svg" className="w-full h-full" preserveAspectRatio="xMidYMid slice">
      {/* Background */}
      <rect width={200} height={220} fill={bg} />

      {/* Shirt peeking from bottom */}
      <path d="M -2 220 L -2 190 Q 40 180 100 178 Q 160 180 202 190 L 202 220 Z" fill={shirt} />

      {/* Neck */}
      <rect x={87} y={181} width={26} height={18} rx={5} fill={skin.face} />

      {/* Hair — behind everything else */}
      {renderHair(config.hair, hair)}

      {/* Ears */}
      <ellipse cx={27}  cy={116} rx={12} ry={15} fill={skin.face} stroke="#0002" strokeWidth={1.5} />
      <ellipse cx={173} cy={116} rx={12} ry={15} fill={skin.face} stroke="#0002" strokeWidth={1.5} />
      <ellipse cx={25}  cy={116} rx={6}  ry={8}  fill={skin.cheek} opacity={0.28} />
      <ellipse cx={175} cy={116} rx={6}  ry={8}  fill={skin.cheek} opacity={0.28} />

      {/* Face */}
      <circle cx={100} cy={118} r={68} fill={skin.face} stroke="#0002" strokeWidth={2.5} />

      {/* Features */}
      {renderEyes(config.eyes, eye)}
      {renderBrows(config.brows, hair)}
      {renderNose(config.nose, skin.nose)}
      {renderMouth(config.mouth, skin.mouth, skin.hi)}
      {renderGlasses(config.glasses)}
    </svg>
  )
}

// ─── Controls ─────────────────────────────────────────────────────────────────

function SwatchRow({
  palette, selected, onSelect,
}: {
  palette: ReadonlyArray<{ color: string; label: string }>
  selected: number
  onSelect: (i: number) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {palette.map((p, i) => (
        <button
          key={i}
          title={p.label}
          onClick={() => onSelect(i)}
          className="w-6 h-6 rounded-full flex-shrink-0"
          style={{
            backgroundColor: p.color,
            boxShadow: selected === i
              ? "0 0 0 2px #fff, 0 0 0 4px rgba(255,255,255,0.35)"
              : "0 0 0 1px rgba(255,255,255,0.15)",
            transform: selected === i ? "scale(1.2)" : "scale(1)",
            transition: "transform 0.1s, box-shadow 0.1s",
          }}
        />
      ))}
    </div>
  )
}

const OTHER_FEATURES = [
  { key: "eyes"    as const, label: "Eyes",    opts: ["Lash",  "Oval",  "Dot"]    },
  { key: "brows"   as const, label: "Brows",   opts: ["Flat",  "Arched", "Bold"]   },
  { key: "nose"    as const, label: "Nose",    opts: ["Arch",  "U",      "Nostrils"] },
  { key: "mouth"   as const, label: "Mouth",   opts: ["Smile", "Grin",   "Smirk"]  },
  { key: "glasses" as const, label: "Glasses", opts: ["None",  "Round",  "Square", "Shades"] },
]

const COLOR_ROWS = [
  { key: "bgColor"    as const, label: "BG",    palette: BG_PALETTE },
  { key: "skinTone"   as const, label: "Skin",  palette: SKIN_PALETTES.map((s, i) => ({ color: s.face, label: `Skin ${i + 1}` })) },
  { key: "hairColor"  as const, label: "Hair",  palette: HAIR_PALETTE },
  { key: "eyeColor"   as const, label: "Eyes",  palette: EYE_PALETTE },
  { key: "shirtColor" as const, label: "Shirt", palette: SHIRT_PALETTE },
]

const HAIR_OPTS = ["Buzz", "Bob", "Long", "Afro", "Mohawk", "Bun"]

// ─── Deterministic face from UID ──────────────────────────────────────────────

function hashUID(uid: string): number {
  let h = 5381
  for (let i = 0; i < uid.length; i++) {
    h = (((h << 5) + h) ^ uid.charCodeAt(i)) >>> 0
  }
  return h
}

export function faceConfigFromUID(uid: string): FaceConfig {
  let s = hashUID(uid)
  const seeded = (n: number) => { s = (s * 1664525 + 1013904223) >>> 0; return s % n }
  const palette = COORD_PALETTES[seeded(COORD_PALETTES.length)]
  const c: [number, number, number, number] = [...palette.c] as [number, number, number, number]
  for (let i = 3; i > 0; i--) { const j = seeded(i + 1); [c[i], c[j]] = [c[j], c[i]] }
  return {
    hair:       seeded(6),
    eyes:       seeded(3),
    brows:      seeded(3),
    nose:       seeded(3),
    mouth:      seeded(3),
    glasses:    seeded(10) < 7 ? 0 : seeded(3) + 1,
    bgColor:    c[0],
    skinTone:   palette.skin,
    hairColor:  c[1],
    eyeColor:   c[2],
    shirtColor: c[3],
  }
}

export function DJFace({ uid, size = 32 }: { uid: string; size?: number }) {
  const config = useMemo(() => faceConfigFromUID(uid), [uid])
  return (
    <div style={{ width: size, height: size }} className="rounded-lg overflow-hidden flex-shrink-0">
      <FaceSVG config={config} />
    </div>
  )
}

export function FaceGenerator() {
  const [config, setConfig] = useState<FaceConfig>(randomFace)
  const set = useCallback((k: keyof FaceConfig, v: number) => setConfig(p => ({ ...p, [k]: v })), [])

  const btnClass = (active: boolean) =>
    `text-xs py-1 rounded-lg transition-colors truncate ${
      active ? "bg-accent text-white font-semibold" : "bg-surface text-muted hover:text-white hover:bg-border"
    }`

  return (
    <div className="bg-panel rounded-2xl p-6">
      <h2 className="text-white font-semibold mb-5 text-sm tracking-wide uppercase opacity-70">
        Face Generator
      </h2>

      <div className="flex flex-col items-center gap-5">
        {/* Preview — portrait aspect ratio to match 200×220 viewBox */}
        <div className="w-40 h-40 rounded-2xl overflow-hidden shadow-xl flex-shrink-0">
          <FaceSVG config={config} />
        </div>

        {/* Hair style — 6 options in a 3×2 sub-grid */}
        <div className="w-full">
          <p className="text-muted text-xs text-center mb-1.5">Hair Style</p>
          <div className="grid grid-cols-3 gap-1">
            {HAIR_OPTS.map((opt, i) => (
              <button key={i} onClick={() => set("hair", i)} className={btnClass(config.hair === i)}>
                {opt}
              </button>
            ))}
          </div>
        </div>

        {/* Other feature toggles — 3 cols × 2 rows */}
        <div className="w-full grid grid-cols-3 gap-x-3 gap-y-4">
          {OTHER_FEATURES.map(({ key, label, opts }) => (
            <div key={key} className="flex flex-col gap-1.5">
              <p className="text-muted text-xs text-center">{label}</p>
              <div className="flex flex-col gap-1">
                {opts.map((opt, i) => (
                  <button key={i} onClick={() => set(key, i)} className={btnClass(config[key] === i)}>
                    {opt}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Color swatches */}
        <div className="w-full flex flex-col gap-2.5">
          {COLOR_ROWS.map(({ key, label, palette }) => (
            <div key={key} className="flex items-center gap-3">
              <span className="text-muted text-xs w-10 flex-shrink-0">{label}</span>
              <SwatchRow
                palette={palette as ReadonlyArray<{ color: string; label: string }>}
                selected={config[key]}
                onSelect={i => set(key, i)}
              />
            </div>
          ))}
        </div>

        {/* Randomize */}
        <button
          onClick={() => setConfig(randomFace())}
          className="w-full bg-accent hover:bg-accent-hover text-white font-semibold py-2.5 rounded-xl transition-colors text-sm"
        >
          Randomize
        </button>
      </div>
    </div>
  )
}
