/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: '#1a1a1a',
        panel: '#242424',
        border: '#333333',
        accent: '#fc3c44',       // Apple Music red
        'accent-hover': '#e0353c',
        muted: '#888888',
      }
    }
  },
  plugins: []
}
