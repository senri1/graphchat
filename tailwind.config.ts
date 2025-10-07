import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"] ,
  theme: {
    extend: {
      colors: {
        canvas: {
          light: "#f9fafb",
          dark: "#111827"
        }
      },
      boxShadow: {
        card: "0 12px 32px rgba(15, 23, 42, 0.25)"
      }
    }
  },
  plugins: []
};

export default config;
