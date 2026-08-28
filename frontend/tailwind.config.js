/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: '#0A0E15',
        'bg-elev': '#10151F',
        surface: '#141B27',
        'surface-2': '#1A2331',
        hairline: '#243040',
        'hairline-strong': '#324156',
        text: '#E7EDF5',
        'text-muted': '#93A1B5',
        'text-faint': '#5F6E82',
        gain: '#31D6A0',
        'gain-dim': '#1C7A5E',
        loss: '#FF5D6C',
        'loss-dim': '#8F3038',
        warn: '#F0B34A',
        azure: '#3DA9FC',
        'azure-bright': '#6FC3FF',
        gold: '#D9A94E',
        'gold-bright': '#F0C368',
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        eyebrow: ['11px', { lineHeight: '14px', letterSpacing: '0.12em' }],
        'display-xl': ['48px', { lineHeight: '52px' }],
        'display-l': ['34px', { lineHeight: '40px' }],
      },
      borderRadius: {
        sm: '4px',
        DEFAULT: '6px',
        lg: '10px',
      },
      boxShadow: {
        modal: '0 24px 60px -20px rgba(0,0,0,.7)',
        'glow-azure': '0 0 0 1px rgba(61,169,252,.4), 0 0 20px -6px rgba(61,169,252,.6)',
        'glow-gold': '0 0 0 1px rgba(217,169,78,.4), 0 0 20px -6px rgba(217,169,78,.6)',
      },
      keyframes: {
        'modal-in': {
          '0%': { opacity: '0', transform: 'translateY(2px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        // Section-level entrance: a small lift + fade, used to orchestrate a
        // quiet page-load sequence. `both` fill-mode means that even when the
        // reduced-motion override collapses the duration, it lands at opacity 1.
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        // Skeleton loading sweep.
        shimmer: { '100%': { transform: 'translateX(100%)' } },
      },
      animation: {
        'modal-in': 'modal-in 140ms ease-out',
        'fade-in': 'fade-in 120ms ease-out',
        'fade-up': 'fade-up 420ms cubic-bezier(0.22, 1, 0.36, 1) both',
        shimmer: 'shimmer 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
