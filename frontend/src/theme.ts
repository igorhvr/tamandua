import { createTheme } from "@mui/material/styles";

const theme = createTheme({
  palette: {
    mode: "dark",
    primary: {
      main: "#c8a84a",
      light: "#e0c86a",
      dark: "#a8882e",
    },
    secondary: {
      main: "#4a8a5a",
      light: "#6aaa7a",
      dark: "#2a6a3a",
    },
    background: {
      default: "#0c1410",
      paper: "#16201a",
    },
    text: {
      primary: "#d0d8c8",
      secondary: "#7a8a72",
    },
    error: {
      main: "#b84a3a",
      light: "#d86a5a",
    },
    success: {
      main: "#5a9a5a",
      light: "#7aba7a",
    },
    warning: {
      main: "#c8a84a",
    },
    divider: "rgba(208, 216, 200, 0.1)",
  },
  typography: {
    fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    h1: {
      fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: "1.75rem",
      fontWeight: 600,
      letterSpacing: "-0.02em",
      lineHeight: 1.25,
    },
    h2: {
      fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: "1.25rem",
      fontWeight: 600,
      letterSpacing: "-0.015em",
      lineHeight: 1.3,
    },
    h3: {
      fontSize: "1rem",
      fontWeight: 600,
      letterSpacing: "-0.01em",
    },
    body1: {
      fontSize: "0.875rem",
      lineHeight: 1.5,
    },
    body2: {
      fontSize: "0.8125rem",
      lineHeight: 1.45,
    },
    caption: {
      fontSize: "0.6875rem",
      fontWeight: 500,
      letterSpacing: "0.06em",
      textTransform: "uppercase",
    },
  },
  shape: {
    borderRadius: 10,
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          scrollbarColor: "#2a3a2a #0c1410",
          "--font-mono": '"JetBrains Mono", "SF Mono", "Fira Code", monospace',
          "&::-webkit-scrollbar": {
            width: 8,
            height: 8,
          },
          "&::-webkit-scrollbar-track": {
            background: "#0c1410",
          },
          "&::-webkit-scrollbar-thumb": {
            background: "#2a3a2a",
            borderRadius: 4,
          },
        },
        "@keyframes fadeInUp": {
          from: { opacity: 0, transform: "translateY(12px)" },
          to: { opacity: 1, transform: "translateY(0)" },
        },
        "@keyframes fadeIn": {
          from: { opacity: 0 },
          to: { opacity: 1 },
        },
        "@keyframes shimmer": {
          "0%": { backgroundPosition: "-200% center" },
          "100%": { backgroundPosition: "200% center" },
        },
        "@keyframes pulse": {
          "0%": { boxShadow: "0 0 0 0 rgba(200, 168, 74, 0.4)" },
          "70%": { boxShadow: "0 0 0 10px rgba(200, 168, 74, 0)" },
          "100%": { boxShadow: "0 0 0 0 rgba(200, 168, 74, 0)" },
        },
        "@keyframes cardPulse": {
          "0%, 100%": {
            borderColor: "rgba(200, 168, 74, 0.2)",
            boxShadow: "0 0 0 0 rgba(200, 168, 74, 0)",
          },
          "50%": {
            borderColor: "rgba(200, 168, 74, 0.5)",
            boxShadow: "0 0 16px -4px rgba(200, 168, 74, 0.12)",
          },
        },
        "@keyframes breathe": {
          "0%, 100%": { opacity: 1 },
          "50%": { opacity: 0.5 },
        },
        "@keyframes slideUp": {
          from: { opacity: 0, transform: "translateY(8px)" },
          to: { opacity: 1, transform: "translateY(0)" },
        },
        "@keyframes scaleIn": {
          from: { opacity: 0, transform: "scale(0.97)" },
          to: { opacity: 1, transform: "scale(1)" },
        },
        "@keyframes slideRight": {
          "0%, 100%": { transform: "translateX(0)" },
          "50%": { transform: "translateX(4px)" },
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
          border: "1px solid rgba(208, 216, 200, 0.08)",
          transition: "border-color 200ms ease, box-shadow 200ms ease, transform 200ms ease",
          "&:hover": {
            borderColor: "rgba(200, 168, 74, 0.2)",
          },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
        },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: {
          borderBottomColor: "rgba(208, 216, 200, 0.06)",
          padding: "10px 16px",
        },
        head: {
          fontWeight: 600,
          fontSize: "0.6875rem",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "#7a8a72",
        },
      },
    },
    MuiTableRow: {
      styleOverrides: {
        root: {
          transition: "background-color 150ms ease",
          "&:hover": {
            backgroundColor: "rgba(200, 168, 74, 0.03)",
          },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          fontWeight: 600,
          fontSize: "0.6875rem",
          letterSpacing: "0.04em",
          transition: "all 200ms ease",
        },
        outlined: {
          borderColor: "rgba(208, 216, 200, 0.15)",
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: "none",
          fontWeight: 500,
          fontSize: "0.8125rem",
          borderRadius: 8,
          transition: "all 150ms ease",
          "&:active": {
            transform: "scale(0.97)",
          },
        },
        outlined: {
          borderColor: "rgba(208, 216, 200, 0.15)",
          "&:hover": {
            borderColor: "rgba(200, 168, 74, 0.4)",
            backgroundColor: "rgba(200, 168, 74, 0.06)",
          },
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          transition: "all 150ms ease",
          "&:active": {
            transform: "scale(0.9)",
          },
        },
      },
    },
    MuiLinearProgress: {
      styleOverrides: {
        root: {
          borderRadius: 4,
          backgroundColor: "rgba(208, 216, 200, 0.06)",
        },
        bar: {
          transition: "transform 400ms ease, background-color 300ms ease",
          borderRadius: 4,
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          backgroundImage: "none",
          animation: "scaleIn 200ms ease",
        },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          backgroundColor: "#1e2c24",
          border: "1px solid rgba(208, 216, 200, 0.1)",
          fontSize: "0.75rem",
          padding: "6px 10px",
          borderRadius: 6,
        },
      },
    },
  },
});

export default theme;
