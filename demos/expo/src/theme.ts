export const colors = {
  background: {
    primary: "#1e1c1a",
    secondary: "#2a2825",
    tertiary: "#3c3a37",
    error: "#6b211f",
  },
  content: {
    primary: "#ffffff",
    secondary: "#b9b1aa",
    tertiary: "#97908a",
    error: "#ffcac1",
  },
  border: "rgba(163, 156, 148, 0.3)",
  accent: "rgb(63, 82, 149)",
  accentPressed: "rgb(56, 73, 132)",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export const radius = {
  sm: 6,
  md: 8,
  lg: 10,
  xl: 14,
  full: 999,
} as const;

export const fontSize = {
  caption: 12,
  body: 15,
  title: 18,
  display: 28,
} as const;
