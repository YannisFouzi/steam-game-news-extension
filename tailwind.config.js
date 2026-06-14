/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        steam: {
          bg: '#1b2838',
          bgDark: '#171a21',
          text: '#c7d5e0',
          accent: '#66c0f4',
          highlight: '#1a9fff',
        },
      },
      fontFamily: {
        steam: ['"Motiva Sans"', 'Arial', 'Helvetica', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
