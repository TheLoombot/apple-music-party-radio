interface Props {
  error?: string
}

export function SetupScreen({ error }: Props) {
  return (
    <div className="min-h-screen bg-surface flex items-center justify-center p-8">
      <div className="max-w-lg w-full bg-panel rounded-2xl p-8">
        <div className="text-4xl mb-4">🎵</div>
        <h1 className="text-2xl font-bold text-white mb-2">Apple Music Party Radio</h1>
        <p className="text-muted text-sm mb-6">Setup required before you can use the app.</p>

        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 mb-6">
            <p className="text-red-400 text-sm font-mono whitespace-pre-wrap">{error}</p>
          </div>
        )}

        <div className="space-y-5">
          <Step n={1} title="Apple Developer Account ($99/yr)">
            Sign up at{" "}
            <a href="https://developer.apple.com/programs" target="_blank" rel="noreferrer" className="text-accent underline">
              developer.apple.com/programs
            </a>
            . Then go to{" "}
            <em>Certificates, Identifiers &amp; Profiles → Keys → (+)</em>,
            enable <strong className="text-white">Media Services (MusicKit)</strong>, register,
            and download the <code className="bg-surface px-1 rounded text-xs">.p8</code> file.
            Note your <strong className="text-white">Team ID</strong> and <strong className="text-white">Key ID</strong>.
          </Step>

          <Step n={2} title="Copy .env.example → .env">
            <code className="bg-surface px-1 rounded text-xs font-mono">cp .env.example .env</code>
            <br />
            Fill in <code className="bg-surface px-1 rounded text-xs">APPLE_TEAM_ID</code>,{" "}
            <code className="bg-surface px-1 rounded text-xs">APPLE_KEY_ID</code>, and{" "}
            <code className="bg-surface px-1 rounded text-xs">APPLE_PRIVATE_KEY_PATH</code>.
          </Step>

          <Step n={3} title="Generate a Developer Token">
            <code className="bg-surface px-1 rounded text-xs font-mono">npm run generate-token</code>
            <br />
            Paste the output into{" "}
            <code className="bg-surface px-1 rounded text-xs">VITE_APPLE_DEVELOPER_TOKEN</code> in{" "}
            <code className="bg-surface px-1 rounded text-xs">.env</code>.
            Valid for 180 days — rerun when it expires.
          </Step>

          <Step n={4} title="PartyKit (free, sign in with GitHub)">
            <code className="bg-surface px-1 rounded text-xs font-mono">npx partykit login</code>
            <br />
            Then for local dev just run{" "}
            <code className="bg-surface px-1 rounded text-xs font-mono">npm run dev</code>{" "}
            — no extra config needed locally.
            For production, set{" "}
            <code className="bg-surface px-1 rounded text-xs">VITE_PARTYKIT_HOST</code> after deploying.
          </Step>

          <Step n={5} title="Restart the dev server">
            <code className="bg-surface px-1 rounded text-xs font-mono">npm run dev</code>
          </Step>
        </div>
      </div>
    </div>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="w-7 h-7 rounded-full bg-accent/20 text-accent text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
        {n}
      </div>
      <div>
        <p className="text-white text-sm font-semibold mb-1">{title}</p>
        <p className="text-muted text-xs leading-relaxed">{children}</p>
      </div>
    </div>
  )
}
