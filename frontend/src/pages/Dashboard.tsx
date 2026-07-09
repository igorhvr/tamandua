import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import Typography from "@mui/material/Typography";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Chip from "@mui/material/Chip";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Stack from "@mui/material/Stack";
import LinearProgress from "@mui/material/LinearProgress";
import Skeleton from "@mui/material/Skeleton";
import PauseIcon from "@mui/icons-material/Pause";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StopIcon from "@mui/icons-material/Stop";
import DeleteIcon from "@mui/icons-material/Delete";
import OpenInNew from "@mui/icons-material/OpenInNew";
import Timeline from "@mui/icons-material/Timeline";
import Terminal from "@mui/icons-material/Terminal";
import Science from "@mui/icons-material/Science";
import Memory from "@mui/icons-material/Memory";
import {
  fetchRuns,
  fetchEvents,
  fetchMcpStatus,
  fetchLogsTail,
  fetchAutoresearchSessions,
  pauseRun,
  resumeRun,
  cancelRun,
  deleteRun,
  type Run,
  type TamanduaEvent,
  type McpStatus,
  type AutoresearchSession,
} from "../api/client";
import DashboardCharts from "../components/DashboardCharts";

const STATUS_COLORS: Record<string, "success" | "warning" | "error" | "default" | "info"> = {
  running: "info",
  completed: "success",
  failed: "error",
  canceled: "default",
  paused: "warning",
  blocked: "warning",
};

const STATUS_DOT_COLORS: Record<string, string> = {
  running: "#c8a84a",
  completed: "#5a9a5a",
  failed: "#b84a3a",
  canceled: "#7a8a72",
  paused: "#c8a84a",
  blocked: "#b85a3a",
};

function fmtTime(iso: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString();
}

function fmtElapsed(created: string, updated: string, status: string) {
  if (!created) return "—";
  const start = new Date(created).getTime();
  const end = status === "running" ? Date.now() : new Date(updated).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "—";
  const sec = Math.max(0, Math.floor((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

// ── Skeleton Loading ────────────────────────────────────────────────

function DashboardSkeleton() {
  return (
    <Container maxWidth="xl" sx={{ py: 3 }}>
      {[1, 2, 3, 4].map((i) => (
        <Skeleton
          key={i}
          variant="rounded"
          sx={{
            mb: 3,
            height: i === 1 ? 80 : i === 2 ? 240 : i === 3 ? 180 : 260,
            bgcolor: "rgba(208, 216, 200, 0.03)",
            borderRadius: 2,
            animation: "fadeIn 300ms ease",
            animationDelay: `${i * 80}ms`,
          }}
        />
      ))}
    </Container>
  );
}

// ── Empty State ─────────────────────────────────────────────────────

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Box
      sx={{
        py: 5,
        textAlign: "center",
        animation: "fadeInUp 400ms ease",
      }}
    >
      <Box sx={{ color: "text.disabled", mb: 1.5, opacity: 0.5 }}>{icon}</Box>
      <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 500, mb: 0.5 }}>
        {title}
      </Typography>
      <Typography variant="caption" color="text.disabled" sx={{ textTransform: "none", letterSpacing: 0 }}>
        {description}
      </Typography>
    </Box>
  );
}

// ── Section Wrapper ─────────────────────────────────────────────────

function SectionCard({
  icon,
  title,
  delay = 0,
  children,
  actions,
}: {
  icon: React.ReactNode;
  title: string;
  delay?: number;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <Card
      sx={{
        mb: 3,
        animation: "fadeInUp 400ms ease",
        animationDelay: `${delay}ms`,
        animationFillMode: "backwards",
      }}
    >
      <CardContent sx={{ "&:last-child": { pb: 2 } }}>
        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="center"
          sx={{ mb: 1.5 }}
        >
          <Stack direction="row" spacing={1} alignItems="center">
            <Box sx={{ color: "primary.main", display: "flex", opacity: 0.7 }}>{icon}</Box>
            <Typography variant="h2">{title}</Typography>
          </Stack>
          {actions && <Stack direction="row" spacing={1}>{actions}</Stack>}
        </Stack>
        {children}
      </CardContent>
    </Card>
  );
}

// ── Main Dashboard ──────────────────────────────────────────────────

export default function Dashboard() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<Run[]>([]);
  const [events, setEvents] = useState<TamanduaEvent[]>([]);
  const [eventFilter, setEventFilter] = useState<string | null>(null);
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logOffset, setLogOffset] = useState(0);
  const [autoresearchSessions, setAutoresearchSessions] = useState<AutoresearchSession[]>([]);
  const [lastUpdate, setLastUpdate] = useState<string>("--");
  const [loading, setLoading] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  const loadAll = useCallback(async () => {
    try {
      const [runsData, eventsData, mcp, logs, sessions] = await Promise.all([
        fetchRuns(),
        fetchEvents(500),
        fetchMcpStatus(),
        fetchLogsTail(logOffset),
        fetchAutoresearchSessions(),
      ]);
      setRuns(runsData);
      setEvents(eventsData);
      setMcpStatus(mcp);
      setLogLines((prev) => {
        const merged = [...prev, ...logs.lines];
        return merged.slice(-500);
      });
      setLogOffset(logs.nextOffset);
      setAutoresearchSessions(sessions);
      setLastUpdate(new Date().toLocaleTimeString());
    } catch {
      // server may not be ready
    } finally {
      setLoading(false);
    }
  }, [logOffset]);

  useEffect(() => {
    loadAll();
    const interval = setInterval(loadAll, 10000);
    return () => clearInterval(interval);
  }, [loadAll]);



  const handlePause = async (runId: string) => {
    try {
      await pauseRun(runId);
      await loadAll();
    } catch (err) {
      console.error("Failed to pause run:", err);
    }
  };

  const handleResume = async (runId: string) => {
    try {
      await resumeRun(runId);
      await loadAll();
    } catch (err) {
      console.error("Failed to resume run:", err);
    }
  };

  const handleCancel = async (runId: string) => {
    try {
      await cancelRun(runId);
      await loadAll();
    } catch (err) {
      console.error("Failed to cancel run:", err);
    }
  };

  const handleDelete = async (runId: string, status?: string) => {
    const isActive = status === "running" || status === "paused";
    try {
      await deleteRun(runId, isActive);
      await loadAll();
    } catch (err) {
      console.error("Failed to delete run:", err);
    }
  };

  if (loading) {
    return <DashboardSkeleton />;
  }

  return (
    <Container maxWidth="xl" sx={{ py: 3 }}>
      {/* ── MCP Status ── */}
      <SectionCard
        icon={<Memory fontSize="small" />}
        title="MCP Server"
        delay={0}
      >
        {mcpStatus ? (
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={{ xs: 1.5, sm: 3 }}
            alignItems={{ xs: "flex-start", sm: "center" }}
          >
            <Stack direction="row" spacing={1} alignItems="center">
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  bgcolor: mcpStatus.running ? "success.main" : "error.main",
                  ...(mcpStatus.running && {
                    animation: "pulse 2s infinite",
                  }),
                }}
              />
              <Typography
                variant="body2"
                sx={{
                  fontWeight: 600,
                  color: mcpStatus.running ? "success.main" : "error.main",
                }}
              >
                {mcpStatus.running ? "Running" : "Stopped"}
              </Typography>
            </Stack>
            <Typography variant="body2" color="text.secondary">
              Port{" "}
              <Box component="span" sx={{ fontFamily: '"JetBrains Mono", monospace', color: "text.primary" }}>
                {mcpStatus.port}
              </Box>
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Endpoint{" "}
              <Box
                component="a"
                href={`http://localhost:${mcpStatus.port}${mcpStatus.path}`}
                target="_blank"
                rel="noopener noreferrer"
                sx={{
                  fontFamily: '"JetBrains Mono", monospace',
                  color: "primary.light",
                  fontSize: "0.75rem",
                  textDecoration: "underline",
                  textDecorationColor: "rgba(200, 168, 74, 0.3)",
                  transition: "color 150ms ease, text-decoration-color 150ms ease",
                  "&:hover": {
                    color: "primary.main",
                    textDecorationColor: "primary.main",
                  },
                }}
              >
                http://localhost:{mcpStatus.port}{mcpStatus.path}
              </Box>
            </Typography>
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">
            Unable to fetch MCP status.
          </Typography>
        )}
      </SectionCard>

      {/* ── Charts ── */}
      <DashboardCharts runs={runs} events={events} autoresearchSessions={autoresearchSessions} />

      {/* ── Workflow Runs ── */}
      <SectionCard
        icon={<Timeline fontSize="small" />}
        title="Workflow Runs"
        delay={80}
        actions={
          <>
            <Button
              size="small"
              variant="outlined"
              startIcon={<PauseIcon fontSize="small" />}
              onClick={async () => {
                for (const run of runs.filter((r) => r.status === "running")) {
                  await pauseRun(run.id).catch(() => {});
                }
                await loadAll();
              }}
            >
              Pause All
            </Button>
            <Button
              size="small"
              variant="outlined"
              startIcon={<PlayArrowIcon fontSize="small" />}
              onClick={async () => {
                for (const run of runs.filter((r) => r.status === "paused")) {
                  await resumeRun(run.id).catch(() => {});
                }
                await loadAll();
              }}
            >
              Resume All
            </Button>
          </>
        }
      >
        {runs.length === 0 ? (
          <EmptyState
            icon={<Timeline sx={{ fontSize: 40 }} />}
            title="No runs yet"
            description="Start a workflow with tamandua workflow run to see it here."
          />
        ) : (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Run</TableCell>
                  <TableCell>Workflow</TableCell>
                  <TableCell>Task</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Steps</TableCell>
                  <TableCell>Tokens</TableCell>
                  <TableCell>Elapsed</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {runs.map((run, idx) => {
                  const dotColor = STATUS_DOT_COLORS[run.status] ?? "#7a8a72";
                  return (
                    <TableRow
                      key={run.id}
                      hover
                      onClick={() => navigate(`/runs/${run.id}/kanban`)}
                      sx={{
                        cursor: "pointer",
                        animation: "fadeInUp 300ms ease",
                        animationDelay: `${idx * 40}ms`,
                        animationFillMode: "backwards",
                        "&:hover": {
                          backgroundColor: "rgba(200, 168, 74, 0.04)",
                        },
                      }}
                    >
                      <TableCell>
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Box
                            sx={{
                              width: 6,
                              height: 6,
                              borderRadius: "50%",
                              bgcolor: dotColor,
                              flexShrink: 0,
                              ...(run.status === "running" && {
                                animation: "pulse 1.8s infinite",
                              }),
                            }}
                          />
                          <Typography
                            variant="body2"
                            sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: "0.75rem" }}
                          >
                            #{run.run_number ?? run.id.slice(0, 8)}
                          </Typography>
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" sx={{ fontSize: "0.75rem" }}>
                          {run.workflow_id}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Typography
                          variant="body2"
                          sx={{
                            maxWidth: 240,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            fontSize: "0.75rem",
                          }}
                        >
                          {run.task}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={run.status}
                          size="small"
                          color={STATUS_COLORS[run.status] ?? "default"}
                          variant="outlined"
                          sx={{
                            borderColor: `${dotColor}55`,
                            color: dotColor,
                            fontWeight: 600,
                          }}
                        />
                      </TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Typography
                            variant="caption"
                            sx={{ fontFamily: '"JetBrains Mono", monospace', textTransform: "none" }}
                          >
                            {run.completed_steps}/{run.total_steps}
                          </Typography>
                          {run.total_steps > 0 && (
                            <LinearProgress
                              variant="determinate"
                              value={(run.completed_steps / run.total_steps) * 100}
                              sx={{
                                width: 60,
                                height: 4,
                                borderRadius: 2,
                                bgcolor: "rgba(208, 216, 200, 0.06)",
                                "& .MuiLinearProgress-bar": {
                                  bgcolor:
                                    run.failed_steps > 0
                                      ? "error.main"
                                      : "success.main",
                                },
                              }}
                            />
                          )}
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Typography
                          variant="caption"
                          sx={{ fontFamily: '"JetBrains Mono", monospace', textTransform: "none" }}
                        >
                          {(run.tokens_spent ?? 0).toLocaleString()}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption" color="text.secondary" sx={{ textTransform: "none" }}>
                          {fmtElapsed(run.created_at, run.updated_at, run.status)}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">
                        <Stack
                          direction="row"
                          spacing={0.25}
                          justifyContent="flex-end"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Tooltip title="View Kanban board">
                            <IconButton
                              size="small"
                              onClick={() => navigate(`/runs/${run.id}/kanban`)}
                            >
                              <OpenInNew fontSize="small" />
                            </IconButton>
                          </Tooltip>
                          {run.status === "running" && (
                            <Tooltip title="Pause run">
                              <IconButton
                                size="small"
                                onClick={() => handlePause(run.id)}
                              >
                                <PauseIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          )}
                          {run.status === "paused" && (
                            <Tooltip title="Resume run">
                              <IconButton
                                size="small"
                                onClick={() => handleResume(run.id)}
                              >
                                <PlayArrowIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          )}
                          {(run.status === "running" || run.status === "paused") && (
                            <Tooltip title="Cancel run">
                              <IconButton
                                size="small"
                                onClick={() => handleCancel(run.id)}
                              >
                                <StopIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          )}
                          <Tooltip title="Delete run">
                            <IconButton
                              size="small"
                              onClick={() => handleDelete(run.id, run.status)}
                            >
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </SectionCard>

      {/* ── Recent Events ── */}
      <SectionCard
        icon={<Terminal fontSize="small" />}
        title="Recent Events"
        delay={160}
        actions={
          events.length > 0 ? (
            <Stack direction="row" spacing={0.5} flexWrap="wrap">
              <Chip
                label="All"
                size="small"
                variant={eventFilter === null ? "filled" : "outlined"}
                onClick={() => setEventFilter(null)}
                sx={{
                  fontSize: "0.625rem",
                  height: 22,
                  ...(eventFilter === null && {
                    bgcolor: "primary.main",
                    color: "#0c1410",
                    fontWeight: 700,
                  }),
                }}
              />
              {[...new Set(events.map((e) => e.event))].map((type) => (
                <Chip
                  key={type}
                  label={type}
                  size="small"
                  variant={eventFilter === type ? "filled" : "outlined"}
                  onClick={() => setEventFilter(type)}
                  sx={{
                    fontSize: "0.625rem",
                    height: 22,
                    ...(eventFilter === type && {
                      bgcolor: "primary.main",
                      color: "#0c1410",
                      fontWeight: 700,
                    }),
                  }}
                />
              ))}
            </Stack>
          ) : undefined
        }
      >
        {events.length === 0 ? (
          <EmptyState
            icon={<Terminal sx={{ fontSize: 40 }} />}
            title="No events yet"
            description="Events from workflow runs will appear here."
          />
        ) : (
          <Box
            sx={{
              maxHeight: 300,
              overflowY: "auto",
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: "0.75rem",
              borderRadius: 1,
              border: 1,
              borderColor: "divider",
            }}
          >
            {(eventFilter ? events.filter((e) => e.event === eventFilter) : events).map((evt, i) => (
              <Box
                key={i}
                sx={{
                  display: "flex",
                  gap: 1,
                  px: 1.5,
                  py: 0.75,
                  borderBottom: 1,
                  borderColor: "divider",
                  animation: "fadeIn 300ms ease",
                  animationDelay: `${i * 20}ms`,
                  animationFillMode: "backwards",
                  "&:hover": { bgcolor: "rgba(200, 168, 74, 0.03)" },
                  "&:last-child": { borderBottom: 0 },
                }}
              >
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                    textTransform: "none",
                    letterSpacing: 0,
                  }}
                >
                  {evt.ts}
                </Typography>
                <Typography
                  variant="caption"
                  sx={{
                    color: "primary.light",
                    fontWeight: 600,
                    minWidth: 120,
                    flexShrink: 0,
                    textTransform: "none",
                    letterSpacing: 0,
                  }}
                >
                  {evt.event}
                </Typography>
                <Typography
                  variant="caption"
                  color="text.primary"
                  sx={{
                    textTransform: "none",
                    letterSpacing: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {evt.detail ?? ""}
                </Typography>
              </Box>
            ))}
          </Box>
        )}
      </SectionCard>

      {/* ── AutoResearch Sessions ── */}
      {autoresearchSessions.length > 0 && (
        <SectionCard
          icon={<Science fontSize="small" />}
          title="AutoResearch"
          delay={240}
        >
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Goal</TableCell>
                  <TableCell>Metric</TableCell>
                  <TableCell>Runs</TableCell>
                  <TableCell>Baseline</TableCell>
                  <TableCell>Best</TableCell>
                  <TableCell>Last Run</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {autoresearchSessions.map((s, idx) => (
                  <TableRow
                    key={s.id}
                    hover
                    sx={{
                      animation: "fadeInUp 300ms ease",
                      animationDelay: `${idx * 40}ms`,
                      animationFillMode: "backwards",
                    }}
                  >
                    <TableCell>
                      <Typography variant="body2" sx={{ fontSize: "0.75rem", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {s.goal}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" sx={{ textTransform: "none", letterSpacing: 0 }}>
                        {s.metric_name} ({s.metric_unit})
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" sx={{ fontFamily: '"JetBrains Mono", monospace', textTransform: "none" }}>
                        {s.total_runs}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" sx={{ fontFamily: '"JetBrains Mono", monospace', textTransform: "none" }}>
                        {s.baseline_metric?.toFixed(4) ?? "—"}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography
                        variant="caption"
                        sx={{
                          fontFamily: '"JetBrains Mono", monospace',
                          color: "success.main",
                          fontWeight: 600,
                          textTransform: "none",
                        }}
                      >
                        {s.best_metric?.toFixed(4) ?? "—"}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary" noWrap sx={{ textTransform: "none", fontFamily: '"JetBrains Mono", monospace' }}>
                        {s.last_run_at ? fmtTime(s.last_run_at) : "—"}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </SectionCard>
      )}

      {/* ── Logs Tail ── */}
      <SectionCard
        icon={<Terminal fontSize="small" />}
        title="Logs Tail"
        delay={320}
        actions={
          <Button
            size="small"
            variant="outlined"
            onClick={() => {
              setLogLines([]);
              setLogOffset(0);
            }}
          >
            Clear
          </Button>
        }
      >
        <Box
          ref={logRef}
          sx={{
            position: "relative",
            border: 1,
            borderColor: "divider",
            borderRadius: 1,
            bgcolor: "rgba(0,0,0,0.3)",
            minHeight: 220,
            maxHeight: 400,
            overflow: "auto",
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: "0.75rem",
            lineHeight: 1.5,
          }}
        >
          {logLines.length === 0 ? (
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                minHeight: 220,
                color: "text.disabled",
                fontStyle: "italic",
              }}
            >
              Waiting for logs...
            </Box>
          ) : (
            <Box component="pre" sx={{ m: 0, p: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
              {logLines.map((line, i) => (
                <Box
                  key={i}
                  component="span"
                  sx={{ display: "block", animation: "fadeIn 200ms ease", animationFillMode: "backwards" }}
                >
                  {line}
                </Box>
              ))}
              <div ref={logEndRef} />
            </Box>
          )}

        </Box>
      </SectionCard>

      {/* ── Footer ── */}
      <Typography
        variant="caption"
        color="text.disabled"
        sx={{
          textAlign: "right",
          display: "block",
          pb: 2,
          textTransform: "none",
          letterSpacing: 0,
          animation: "fadeIn 500ms ease",
          animationDelay: "400ms",
          animationFillMode: "backwards",
        }}
      >
        Auto-refreshing every 10s · Last update: {lastUpdate}
      </Typography>
    </Container>
  );
}
