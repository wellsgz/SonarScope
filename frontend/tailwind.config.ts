import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ["Space Grotesk", "system-ui", "sans-serif"],
        sans: ["IBM Plex Sans", "system-ui", "sans-serif"]
      },
      colors: {
        sonar: {
          950: "#0b101a",
          900: "#101a29",
          800: "#16243b",
          700: "#1f3659",
          600: "#2c4f82",
          500: "#3564a6",
          400: "#5d8fc5",
          300: "#87b6e0",
          200: "#b8d4ee",
          100: "#dbe8f7",
          50: "#eef4fb"
        }
      },
      boxShadow: {
        panel: "0 20px 40px rgba(6, 14, 28, 0.35)",
        insetglow: "inset 0 0 0 1px rgba(146, 190, 236, 0.24)"
      }
    }
  },
  plugins: []
};

export default config;
