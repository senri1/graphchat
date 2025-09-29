/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: '#0f172a',
        surface: '#1e293b',
        accent: '#38bdf8'
      }
    }
  },
  plugins: []
};
