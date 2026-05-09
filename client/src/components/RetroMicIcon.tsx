export function RetroMicIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" className={className}>
      <rect width="100" height="100" fill="#111"/>

      {/* Capsule */}
      <ellipse cx="50" cy="36" rx="21" ry="27" fill="#545454"/>
      {/* Subtle highlight */}
      <ellipse cx="44" cy="27" rx="9" ry="11" fill="#fff" opacity="0.07"/>
      {/* Rim */}
      <ellipse cx="50" cy="36" rx="21" ry="27" fill="none" stroke="#787878" strokeWidth="2"/>

      {/* Grille bars */}
      <clipPath id="rmi-clip">
        <ellipse cx="50" cy="36" rx="18" ry="24"/>
      </clipPath>
      <g clipPath="url(#rmi-clip)">
        {[14, 21, 28, 35, 42, 49, 56].map(y => (
          <rect key={y} x="32" y={y} width="36" height="3" rx="1.5" fill="#1e1e1e"/>
        ))}
      </g>

      {/* Band */}
      <rect x="37" y="61" width="26" height="8" rx="3" fill="#5f5f5f"/>
      <rect x="37" y="61" width="26" height="8" rx="3" fill="none" stroke="#7a7a7a" strokeWidth="1"/>

      {/* Handle */}
      <rect x="43" y="69" width="14" height="24" rx="6" fill="#404040"/>

      {/* Grip rings */}
      {[76, 82, 88].map(y => (
        <rect key={y} x="43" y={y} width="14" height="2.5" rx="1" fill="#252525"/>
      ))}
    </svg>
  )
}
