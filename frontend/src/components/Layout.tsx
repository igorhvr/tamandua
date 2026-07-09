import { useState, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Box from "@mui/material/Box";
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import ArrowBack from "@mui/icons-material/ArrowBack";
import tamanduaLogo from "../assets/tamandua-logo.png";
import { fetchStats, fetchVersion, fetchVersionStatus } from "../api/client";

interface LayoutProps {
  children: React.ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const isKanban = location.pathname.includes("/kanban");
  const [stats, setStats] = useState({ systemTokens: 0, totalTokens: 0 });
  const [version, setVersion] = useState<string | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [contentKey, setContentKey] = useState(0);
  const prevPath = useRef(location.pathname);

  // Bump content key on route change to re-trigger entrance animations
  useEffect(() => {
    if (prevPath.current !== location.pathname) {
      setContentKey((k) => k + 1);
      prevPath.current = location.pathname;
    }
  }, [location.pathname]);

  useEffect(() => {
    const load = async () => {
      try {
        const [s, v, vs] = await Promise.all([
          fetchStats(),
          fetchVersion(),
          fetchVersionStatus(),
        ]);
        setStats({ systemTokens: s.systemTokensSpent, totalTokens: s.totalTokensSpent });
        setVersion(v.version);
        setUpdateAvailable(vs.updateAvailable ?? false);
      } catch {
        // server may not be ready
      }
    };
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      {/* ── App Bar with diagonal "vest" motif ── */}
      <AppBar
        position="static"
        elevation={0}
        sx={{
          borderBottom: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
          position: "relative",
          overflow: "hidden",
          "&::before": {
            content: '""',
            position: "absolute",
            inset: 0,
            background: `repeating-linear-gradient(
              30deg,
              transparent,
              transparent 48px,
              rgba(200, 168, 74, 0.035) 48px,
              rgba(200, 168, 74, 0.035) 50px
            )`,
            pointerEvents: "none",
          },
        }}
      >
        <Toolbar sx={{ gap: 1.5, minHeight: 56, position: "relative", zIndex: 1 }}>
          {isKanban && (
            <IconButton
              size="small"
              onClick={() => navigate("/")}
              sx={{ color: "text.secondary" }}
            >
              <ArrowBack fontSize="small" />
            </IconButton>
          )}
          <Box
            component="img"
            src={tamanduaLogo}
            alt="Tamandua"
            sx={{ height: 28, width: "auto" }}
          />
          <Typography
            variant="h1"
            sx={{
              fontSize: "1.125rem",
              color: "primary.main",
            }}
          >
            Tamandua
          </Typography>
          {!isKanban && (
            <Typography
              variant="caption"
              sx={{ color: "text.secondary", ml: 0.5, textTransform: "none", letterSpacing: "0.02em" }}
            >
              Agent Orchestrator
            </Typography>
          )}

          <Box sx={{ flex: 1 }} />

          {!isKanban && (
            <Tooltip title="System tokens spent (daemon, scheduler, medic)">
              <Chip
                label={`Sys ${stats.systemTokens.toLocaleString()}`}
                size="small"
                variant="outlined"
                sx={{
                  borderColor: "divider",
                  color: "text.secondary",
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: "0.6875rem",
                  "&:hover": { borderColor: "primary.main", color: "primary.light" },
                }}
              />
            </Tooltip>
          )}
          {!isKanban && (
            <Tooltip title="Total tokens spent across all runs">
              <Chip
                label={`${stats.totalTokens.toLocaleString()}`}
                size="small"
                variant="outlined"
                sx={{
                  borderColor: "primary.main",
                  color: "primary.main",
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: "0.6875rem",
                }}
              />
            </Tooltip>
          )}

          {version && (
            <Tooltip title={`Build ${version}`}>
              <Typography
                variant="caption"
                sx={{
                  color: "text.disabled",
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: "0.625rem",
                  maxWidth: 200,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  cursor: "default",
                }}
              >
                {version}
              </Typography>
            </Tooltip>
          )}

          <Box
            sx={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              bgcolor: "success.main",
              flexShrink: 0,
              animation: "breathe 3s ease-in-out infinite",
            }}
          />
        </Toolbar>
      </AppBar>

      {/* ── Update Banner ── */}
      {updateAvailable && (
        <Box
          sx={{
            bgcolor: "rgba(200, 168, 74, 0.12)",
            color: "primary.light",
            px: 3,
            py: 1,
            textAlign: "center",
            fontSize: "0.8125rem",
            fontWeight: 500,
            borderBottom: 1,
            borderColor: "rgba(200, 168, 74, 0.15)",
            animation: "slideUp 300ms ease",
          }}
        >
          A new version is available. Run{" "}
          <Box
            component="code"
            sx={{
              bgcolor: "rgba(0,0,0,0.25)",
              px: 1,
              py: 0.25,
              borderRadius: 0.5,
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: "0.75rem",
              color: "primary.main",
            }}
          >
            tamandua update
          </Box>
        </Box>
      )}

      {/* ── Main Content ── */}
      <Box
        key={contentKey}
        component="main"
        sx={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          animation: "fadeInUp 400ms ease",
        }}
      >
        {children}
      </Box>
    </Box>
  );
}
