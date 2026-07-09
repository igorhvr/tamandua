import { useState, useEffect, useCallback, useRef } from "react";
import { useParams } from "react-router-dom";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Skeleton from "@mui/material/Skeleton";
import CloseIcon from "@mui/icons-material/Close";
import AccessTime from "@mui/icons-material/AccessTime";
import TokenIcon from "@mui/icons-material/Token";
import Replay from "@mui/icons-material/Replay";
import ErrorOutline from "@mui/icons-material/ErrorOutline";
import CheckCircleOutline from "@mui/icons-material/CheckCircleOutline";
import Pause from "@mui/icons-material/Pause";
import PlayArrow from "@mui/icons-material/PlayArrow";
import Stop from "@mui/icons-material/Stop";
import DoubleArrow from "@mui/icons-material/DoubleArrow";
import SmartToy from "@mui/icons-material/SmartToy";
import CheckCircle from "@mui/icons-material/CheckCircle";
import Error from "@mui/icons-material/Error";
import HourglassEmpty from "@mui/icons-material/HourglassEmpty";
import PlayCircle from "@mui/icons-material/PlayCircle";
import Flag from "@mui/icons-material/Flag";
import {
  fetchKanban,
  fetchKanbanCardDetail,
  fetchRunEvents,
  pauseRun,
  resumeRun,
  cancelRun,
  type KanbanSnapshot,
  type KanbanLane,
  type KanbanCard,
  type KanbanCardDetail,
  type TamanduaEvent,
} from "../api/client";
import MarkdownRenderer from "../components/MarkdownRenderer";

const LANE_STATUS_COLORS: Record<string, string> = {
  todo: "#7a8a72",
  running: "#c8a84a",
  done: "#5a9a5a",
  failed: "#b84a3a",
};

const CARD_STATUS_COLORS: Record<string, string> = {
  todo: "#7a8a72",
  running: "#c8a84a",
  done: "#5a9a5a",
  failed: "#b84a3a",
};

const CARD_STATUS_ICONS: Record<string, React.ReactNode> = {
  done: <CheckCircleOutline sx={{ fontSize: 14, color: "#5a9a5a" }} />,
  failed: <ErrorOutline sx={{ fontSize: 14, color: "#b84a3a" }} />,
};

function fmtElapsed(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${Math.floor(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}m ${s}s`;
}

/**
 * Compute elapsed seconds between a reference ISO timestamp and now.
 * Used for live-running cards where we want a ticking clock.
 */
function fmtElapsedSince(iso: string | undefined | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  return fmtElapsed(sec);
}

function fmtTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString();
}

// ── Kanban Skeleton ─────────────────────────────────────────────────

function KanbanSkeleton() {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <Box sx={{ px: 3, py: 2, borderBottom: 1, borderColor: "divider", bgcolor: "background.paper" }}>
        <Stack direction="row" spacing={4}>
          {[1, 2, 3, 4].map((i) => (
            <Box key={i}>
              <Skeleton variant="text" width={40} sx={{ bgcolor: "rgba(208, 216, 200, 0.05)" }} />
              <Skeleton variant="text" width={80} sx={{ bgcolor: "rgba(208, 216, 200, 0.05)", mt: 0.5 }} />
            </Box>
          ))}
        </Stack>
      </Box>
      <Box sx={{ flex: 1, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 1.75, p: 2.5 }}>
        {[1, 2, 3, 4].map((i) => (
          <Skeleton
            key={i}
            variant="rounded"
            sx={{ bgcolor: "rgba(208, 216, 200, 0.03)", borderRadius: 1.5 }}
          />
        ))}
      </Box>
    </Box>
  );
}

// ── Lane Card ───────────────────────────────────────────────────────

function LaneCard({
  card,
  laneStatus,
  onClick,
  index,
  generatedAt,
}: {
  card: KanbanCard;
  laneStatus: string;
  onClick: () => void;
  index: number;
  generatedAt?: string;
}) {
  const color = CARD_STATUS_COLORS[card.status] ?? "#7a8a72";
  const isRunning = card.status === "running";
  const statusIcon = CARD_STATUS_ICONS[card.status];
  const isRetriesExhausted = card.sub.startsWith("retries exhausted");

  // For running cards, show a live elapsed time instead of static "updated HH:MM"
  const displaySub = isRunning && generatedAt
    ? `running ${fmtElapsedSince(generatedAt)}`
    : card.sub;

  return (
    <Box
      onClick={onClick}
      sx={{
        bgcolor: isRetriesExhausted ? "rgba(184, 74, 58, 0.06)" : "rgba(208, 216, 200, 0.02)",
        border: 1,
        borderColor: isRetriesExhausted ? "rgba(184, 74, 58, 0.3)" : "divider",
        borderLeft: 3,
        borderLeftColor: color,
        borderRadius: 1.5,
        p: 1.25,
        cursor: "pointer",
        transition: "all 180ms ease",
        animation: "fadeInUp 300ms ease",
        animationDelay: `${index * 60}ms`,
        animationFillMode: "backwards",
        ...(isRunning && {
          animation: "cardPulse 2.4s infinite ease-in-out, fadeInUp 300ms ease",
          animationDelay: `${index * 60}ms, ${index * 60}ms`,
          animationFillMode: "backwards, backwards",
        }),
        "&:hover": {
          borderColor: "primary.main",
          borderLeftColor: "primary.main",
          bgcolor: "rgba(200, 168, 74, 0.04)",
          transform: "translateY(-1px)",
          boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
        },
        "&:active": {
          transform: "translateY(0)",
        },
      }}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
        <Stack direction="row" spacing={0.75} alignItems="center">
          {statusIcon ?? (
            <Box
              sx={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                bgcolor: color,
                display: "inline-block",
                flexShrink: 0,
              }}
            />
          )}
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              fontWeight: 500,
              fontFamily: '"JetBrains Mono", monospace',
              textTransform: "none",
              letterSpacing: 0,
            }}
          >
            {card.id}
          </Typography>
        </Stack>
        <Typography
          variant="caption"
          color={isRetriesExhausted ? "error.main" : "text.secondary"}
          sx={{
            textTransform: "none",
            letterSpacing: 0,
            flexShrink: 0,
            fontWeight: isRetriesExhausted ? 600 : 400,
          }}
        >
          {displaySub}
        </Typography>
      </Stack>
      <Typography
        variant="body2"
        sx={{
          fontWeight: 500,
          mt: 0.5,
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
          lineHeight: 1.4,
        }}
      >
        {card.title}
      </Typography>
    </Box>
  );
}

// ── Lane Column ─────────────────────────────────────────────────────

function LaneColumn({ lane, onCardClick, generatedAt, cardStatusFilter }: { lane: KanbanLane; onCardClick: (cardId: string) => void; generatedAt?: string; cardStatusFilter: string | null }) {
  const color = LANE_STATUS_COLORS[lane.status] ?? "#7a8a72";

  const filteredCards = cardStatusFilter
    ? lane.cards.filter((c) => c.status === cardStatusFilter)
    : lane.cards;

  // Compute summary from filtered cards
  const filteredSummary = (() => {
    let done = 0;
    let failed = 0;
    let running = 0;
    for (const c of filteredCards) {
      if (c.status === "done") done++;
      else if (c.status === "failed") failed++;
      else if (c.status === "running") running++;
    }
    return { done, failed, running, total: filteredCards.length };
  })();

  return (
    <Box
      sx={{
        bgcolor: "background.paper",
        border: 1,
        borderColor: "divider",
        borderRadius: 1.5,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        animation: "fadeInUp 400ms ease",
        animationFillMode: "backwards",
      }}
    >
      {/* Lane Header */}
      <Box sx={{ px: 2, py: 1.5, borderBottom: 1, borderColor: "divider" }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Box
            sx={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              bgcolor: color,
              ...(lane.status === "running" && {
                animation: "pulse 1.8s infinite",
              }),
            }}
          />
          <Typography
            variant="caption"
            sx={{
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
            }}
          >
            {lane.label}
          </Typography>
          <Chip
            label={filteredCards.length}
            size="small"
            sx={{
              height: 18,
              minWidth: 18,
              fontSize: "0.625rem",
              fontWeight: 600,
              bgcolor: "rgba(208, 216, 200, 0.06)",
              color: "text.secondary",
              "& .MuiChip-label": { px: 0.5 },
            }}
          />
          {cardStatusFilter && filteredCards.length !== lane.cards.length && (
            <Typography
              variant="caption"
              color="text.disabled"
              sx={{ textTransform: "none", letterSpacing: 0, fontSize: "0.625rem" }}
            >
              of {lane.cards.length}
            </Typography>
          )}
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.25, display: "block", textTransform: "none", letterSpacing: 0 }}>
          {lane.stepId} · {lane.stepType}
        </Typography>
      </Box>

      {/* Cards */}
      <Box
        sx={{
          flex: 1,
          p: 1.25,
          display: "flex",
          flexDirection: "column",
          gap: 1,
          overflowY: "auto",
          minHeight: 80,
        }}
      >
        {filteredCards.length === 0 ? (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flex: 1,
              minHeight: 60,
            }}
          >
            <Typography
              variant="caption"
              color="text.disabled"
              sx={{ textTransform: "none", letterSpacing: 0, fontStyle: "italic" }}
            >
              {cardStatusFilter ? `No ${cardStatusFilter} items` : "No items"}
            </Typography>
          </Box>
        ) : (
          filteredCards.map((card, idx) => (
            <LaneCard
              key={card.id}
              card={card}
              laneStatus={lane.status}
              index={idx}
              generatedAt={generatedAt}
              onClick={() => onCardClick(card.id)}
            />
          ))
        )}
      </Box>

      {/* Lane Footer — Summary Bar */}
      <Box sx={{ borderTop: 1, borderColor: "divider", px: 1.75, py: 1.5 }}>
        <Box
          sx={{
            height: 6,
            bgcolor: "rgba(208, 216, 200, 0.06)",
            borderRadius: 1,
            overflow: "hidden",
            display: "flex",
            mb: 0.75,
          }}
        >
          {filteredSummary.total > 0 && (
            <>
              {filteredSummary.done > 0 && (
                <Box
                  sx={{
                    width: `${(filteredSummary.done / filteredSummary.total) * 100}%`,
                    bgcolor: "success.main",
                    transition: "width 500ms ease",
                  }}
                />
              )}
              {filteredSummary.running > 0 && (
                <Box
                  sx={{
                    width: `${(filteredSummary.running / filteredSummary.total) * 100}%`,
                    bgcolor: "warning.main",
                    transition: "width 500ms ease",
                  }}
                />
              )}
              {filteredSummary.failed > 0 && (
                <Box
                  sx={{
                    width: `${(filteredSummary.failed / filteredSummary.total) * 100}%`,
                    bgcolor: "error.main",
                    transition: "width 500ms ease",
                  }}
                />
              )}
            </>
          )}
        </Box>
        <Stack direction="row" spacing={1.5} flexWrap="wrap">
          {filteredSummary.done > 0 && (
            <Typography variant="caption" sx={{ color: "success.main", fontWeight: 500, textTransform: "none", letterSpacing: 0 }}>
              {filteredSummary.done} done
            </Typography>
          )}
          {filteredSummary.running > 0 && (
            <Typography variant="caption" sx={{ color: "warning.main", fontWeight: 500, textTransform: "none", letterSpacing: 0 }}>
              {filteredSummary.running} running
            </Typography>
          )}
          {filteredSummary.failed > 0 && (
            <Typography variant="caption" sx={{ color: "error.main", fontWeight: 500, textTransform: "none", letterSpacing: 0 }}>
              {filteredSummary.failed} failed
            </Typography>
          )}
          {filteredSummary.done === 0 && filteredSummary.running === 0 && filteredSummary.failed === 0 && (
            <Typography variant="caption" color="text.disabled" sx={{ textTransform: "none", letterSpacing: 0 }}>
              {filteredSummary.total} pending
            </Typography>
          )}
        </Stack>
      </Box>
    </Box>
  );
}

// ── Chat Helpers ────────────────────────────────────────────────────

interface ChatMessageData {
  id: string;
  agent: string;
  icon: React.ReactNode;
  color: string;
  text: string;
  detail?: string;
  ts: string;
}

function formatChatEvent(evt: TamanduaEvent): ChatMessageData {
  const agent = evt.agentId
    ? evt.agentId.split("_").slice(-1)[0].replace(/^./, (c) => c.toUpperCase())
    : "";
  const time = new Date(evt.ts).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  switch (evt.event) {
    case "run.started":
      return {
        id: evt.ts + evt.event,
        agent: "System",
        icon: <PlayCircle sx={{ fontSize: 16 }} />,
        color: "#5a9a5a",
        text: "Run started",
        ts: time,
      };
    case "run.completed":
      return {
        id: evt.ts + evt.event,
        agent: "System",
        icon: <CheckCircle sx={{ fontSize: 16 }} />,
        color: "#5a9a5a",
        text: "Run completed",
        ts: time,
      };
    case "run.failed":
      return {
        id: evt.ts + evt.event,
        agent: "System",
        icon: <Error sx={{ fontSize: 16 }} />,
        color: "#b84a3a",
        text: "Run failed",
        detail: evt.detail,
        ts: time,
      };
    case "run.tokens.updated":
      return {
        id: evt.ts + evt.event,
        agent: "System",
        icon: <TokenIcon sx={{ fontSize: 14 }} />,
        color: "#c8a84a",
        text: `Tokens: ${evt.tokenDelta != null ? (evt.tokenDelta >= 0 ? "+" : "") + evt.tokenDelta : ""}${evt.tokensSpent != null ? ` (total ${evt.tokensSpent})` : ""}`,
        ts: time,
      };
    case "step.pending":
      return {
        id: evt.ts + evt.event,
        agent: agent || "Step",
        icon: <HourglassEmpty sx={{ fontSize: 16 }} />,
        color: "#7a8a72",
        text: `${agent || "Step"} is waiting in line`,
        detail: evt.detail,
        ts: time,
      };
    case "step.running":
      return {
        id: evt.ts + evt.event,
        agent: agent || "Agent",
        icon: <SmartToy sx={{ fontSize: 16 }} />,
        color: "#c8a84a",
        text: `${agent || "Agent"} started working`,
        detail: evt.detail,
        ts: time,
      };
    case "step.done":
      return {
        id: evt.ts + evt.event,
        agent: agent || "Step",
        icon: <CheckCircle sx={{ fontSize: 16 }} />,
        color: "#5a9a5a",
        text: `${agent || "Step"} completed`,
        detail: evt.detail,
        ts: time,
      };
    case "step.failed":
      return {
        id: evt.ts + evt.event,
        agent: agent || "Step",
        icon: <Error sx={{ fontSize: 16 }} />,
        color: "#b84a3a",
        text: `${agent || "Step"} failed`,
        detail: evt.detail,
        ts: time,
      };
    case "step.timeout":
      return {
        id: evt.ts + evt.event,
        agent: agent || "Step",
        icon: <Error sx={{ fontSize: 16 }} />,
        color: "#b84a3a",
        text: `${agent || "Step"} timed out`,
        detail: evt.detail,
        ts: time,
      };
    case "story.started":
      return {
        id: evt.ts + evt.event,
        agent: agent || "Planner",
        icon: <Flag sx={{ fontSize: 16 }} />,
        color: "#c8a84a",
        text: evt.storyTitle || "Story started",
        ts: time,
      };
    case "story.done":
      return {
        id: evt.ts + evt.event,
        agent: agent || "Developer",
        icon: <CheckCircle sx={{ fontSize: 16 }} />,
        color: "#5a9a5a",
        text: `✅ ${evt.storyTitle || "Story"} done`,
        ts: time,
      };
    case "story.verified":
      return {
        id: evt.ts + evt.event,
        agent: "Verifier",
        icon: <CheckCircle sx={{ fontSize: 16 }} />,
        color: "#5a9a5a",
        text: `Verified: ${evt.storyTitle || "Story"}`,
        ts: time,
      };
    case "story.failed":
      return {
        id: evt.ts + evt.event,
        agent: agent || "Developer",
        icon: <Error sx={{ fontSize: 16 }} />,
        color: "#b84a3a",
        text: `${evt.storyTitle || "Story"} failed`,
        detail: evt.detail,
        ts: time,
      };
    case "story.retry":
      return {
        id: evt.ts + evt.event,
        agent: agent || "Developer",
        icon: <Replay sx={{ fontSize: 16 }} />,
        color: "#c8a84a",
        text: `Retrying: ${evt.storyTitle || "Story"}`,
        detail: evt.detail,
        ts: time,
      };
    case "pipeline.advanced":
      return {
        id: evt.ts + evt.event,
        agent: "System",
        icon: <DoubleArrow sx={{ fontSize: 16 }} />,
        color: "#7a8a72",
        text: "Pipeline advanced",
        detail: evt.detail,
        ts: time,
      };
    case "agent.nudged":
      return {
        id: evt.ts + evt.event,
        agent: agent || "Agent",
        icon: <SmartToy sx={{ fontSize: 16 }} />,
        color: "#c8a84a",
        text: `${agent || "Agent"} was nudged`,
        ts: time,
      };
    default:
      return {
        id: evt.ts + evt.event,
        agent: agent || "System",
        icon: <SmartToy sx={{ fontSize: 14 }} />,
        color: "#7a8a72",
        text: evt.event,
        detail: evt.detail,
        ts: time,
      };
  }
}

function ChatMessage({ msg, isLatest }: { msg: ChatMessageData; isLatest: boolean }) {
  return (
    <Box
      sx={{
        display: "flex",
        gap: 1.25,
        px: 1.5,
        py: 0.75,
        animation: isLatest ? "fadeInUp 250ms ease" : undefined,
        transition: "background-color 150ms ease",
        "&:hover": { bgcolor: "rgba(200, 168, 74, 0.03)" },
      }}
    >
      {/* Avatar */}
      <Box
        sx={{
          width: 28,
          height: 28,
          borderRadius: "50%",
          bgcolor: `${msg.color}18`,
          color: msg.color,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          mt: 0.25,
        }}
      >
        {msg.icon}
      </Box>

      {/* Bubble */}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: "flex", alignItems: "baseline", gap: 0.75, mb: 0.15 }}>
          <Typography
            variant="caption"
            sx={{
              fontWeight: 600,
              color: msg.color,
              fontSize: "0.6875rem",
              textTransform: "none",
              letterSpacing: 0,
            }}
          >
            {msg.agent}
          </Typography>
          <Typography
            variant="caption"
            sx={{
              color: "text.disabled",
              fontSize: "0.625rem",
              textTransform: "none",
              letterSpacing: 0,
            }}
          >
            {msg.ts}
          </Typography>
        </Box>
        <Typography
          variant="body2"
          sx={{
            color: "text.primary",
            fontSize: "0.8125rem",
            lineHeight: 1.45,
            textTransform: "none",
            letterSpacing: 0,
          }}
        >
          {msg.text}
        </Typography>
        {msg.detail && (
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              fontSize: "0.6875rem",
              mt: 0.15,
              display: "block",
              textTransform: "none",
              letterSpacing: 0,
              fontStyle: "italic",
            }}
          >
            {msg.detail}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

// ── Main Kanban ─────────────────────────────────────────────────────

export default function Kanban() {
  const { runId } = useParams<{ runId: string }>();
  const [snapshot, setSnapshot] = useState<KanbanSnapshot | null>(null);
  const [cardDetail, setCardDetail] = useState<KanbanCardDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [chatEvents, setChatEvents] = useState<TamanduaEvent[]>([]);
  const [prevTokens, setPrevTokens] = useState(0);
  const [cardStatusFilter, setCardStatusFilter] = useState<string | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const [tick, setTick] = useState(0);
  // Tick every second to update live elapsed displays
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // Auto-scroll chat to bottom on new events
  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [chatEvents]);

  const load = useCallback(async () => {
    if (!runId) return;
    try {
      const [data, events] = await Promise.all([
        fetchKanban(runId),
        fetchRunEvents(runId),
      ]);
      setSnapshot(data);
      setPrevTokens((prev) => Math.max(prev, data.run.tokens_spent));
      setChatEvents(events);
    } catch (err) {
      console.error("Failed to load kanban:", err);
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, [load]);

  const openCardDetail = async (cardId: string) => {
    if (!runId) return;
    try {
      const detail = await fetchKanbanCardDetail(runId, cardId);
      setCardDetail(detail);
      setDetailOpen(true);
    } catch (err) {
      console.error("Failed to load card detail:", err);
    }
  };

  if (loading) {
    return <KanbanSkeleton />;
  }

  if (!snapshot) {
    return (
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flex: 1,
          animation: "fadeIn 300ms ease",
        }}
      >
        <Box sx={{ textAlign: "center" }}>
          <ErrorOutline sx={{ fontSize: 48, color: "error.main", mb: 1, opacity: 0.6 }} />
          <Typography color="error" variant="body1" sx={{ fontWeight: 500 }}>
            Run not found
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {runId}
          </Typography>
        </Box>
      </Box>
    );
  }

  const { run, lanes } = snapshot;
  const runStatusColor = LANE_STATUS_COLORS[run.status] ?? "#7a8a72";

  const handlePause = async () => {
    if (!runId || actionLoading) return;
    setActionLoading("pause");
    setActionError(null);
    try {
      await pauseRun(runId);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to pause run");
    } finally {
      setActionLoading(null);
    }
  };

  const handleResume = async () => {
    if (!runId || actionLoading) return;
    setActionLoading("resume");
    setActionError(null);
    try {
      await resumeRun(runId);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to resume run");
    } finally {
      setActionLoading(null);
    }
  };

  const handleCancel = async () => {
    if (!runId || actionLoading) return;
    setActionLoading("cancel");
    setActionError(null);
    try {
      await cancelRun(runId);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to cancel run");
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* ── Header ── */}
      <Box
        sx={{
          px: 3,
          py: 2,
          borderBottom: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
          animation: "fadeInUp 300ms ease",
        }}
      >
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={{ xs: 1.5, sm: 4 }}
          alignItems={{ xs: "flex-start", sm: "center" }}
          flexWrap="wrap"
        >
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Run
            </Typography>
            <Typography
              variant="body2"
              sx={{ fontFamily: '"JetBrains Mono", monospace', fontWeight: 500, mt: 0.25 }}
            >
              #{run.run_number ?? run.id.slice(0, 8)}
            </Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Workflow
            </Typography>
            <Typography variant="body2" sx={{ fontWeight: 500, mt: 0.25 }}>
              {run.workflow_id}
            </Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Status
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.25 }}>
              <Box
                sx={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  bgcolor: runStatusColor,
                  ...(run.status === "running" && {
                    animation: "pulse 1.8s infinite",
                  }),
                }}
              />
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {run.status}
              </Typography>
            </Stack>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>
              <Stack direction="row" spacing={0.5} alignItems="center">
                <AccessTime sx={{ fontSize: 12 }} />
                <span>Elapsed</span>
              </Stack>
            </Typography>
            <Typography variant="body2" sx={{ fontWeight: 500, mt: 0.25, fontFamily: '"JetBrains Mono", monospace' }}>
              {run.status === "running"
                ? fmtElapsedSince(run.created_at)
                : fmtElapsed(run.elapsed_seconds)}
            </Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>
              <Stack direction="row" spacing={0.5} alignItems="center">
                <TokenIcon sx={{ fontSize: 12 }} />
                <span>Tokens</span>
              </Stack>
            </Typography>
            <Typography
              variant="body2"
              sx={{
                fontFamily: '"JetBrains Mono", monospace',
                fontWeight: 500,
                mt: 0.25,
                transition: "color 300ms ease",
                ...(run.tokens_spent > prevTokens && {
                  color: "warning.main",
                }),
              }}
            >
              {(run.tokens_spent ?? 0).toLocaleString()}
            </Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Task
            </Typography>
            <Typography
              variant="body2"
              sx={{
                fontWeight: 500,
                mt: 0.25,
                maxWidth: 300,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {run.task}
            </Typography>
          </Box>

          {/* ── Actions ── */}
          <Box sx={{ ml: "auto", display: "flex", alignItems: "center", gap: 1 }}>
            {actionError && (
              <Typography
                variant="caption"
                color="error"
                sx={{ textTransform: "none", letterSpacing: 0, mr: 1 }}
              >
                {actionError}
              </Typography>
            )}
            {run.status === "running" && (
              <Button
                variant="outlined"
                size="small"
                color="warning"
                startIcon={
                  actionLoading === "pause" ? (
                    <CircularProgress size={14} color="inherit" />
                  ) : (
                    <Pause fontSize="small" />
                  )
                }
                onClick={handlePause}
                disabled={actionLoading !== null}
                sx={{
                  textTransform: "none",
                  letterSpacing: 0,
                  fontWeight: 500,
                  borderColor: "warning.main",
                  color: "warning.main",
                  "&:hover": {
                    borderColor: "warning.light",
                    bgcolor: "rgba(200, 168, 74, 0.08)",
                  },
                }}
              >
                Pause
              </Button>
            )}
            {run.status === "paused" && (
              <Button
                variant="outlined"
                size="small"
                color="success"
                startIcon={
                  actionLoading === "resume" ? (
                    <CircularProgress size={14} color="inherit" />
                  ) : (
                    <PlayArrow fontSize="small" />
                  )
                }
                onClick={handleResume}
                disabled={actionLoading !== null}
                sx={{
                  textTransform: "none",
                  letterSpacing: 0,
                  fontWeight: 500,
                  borderColor: "success.main",
                  color: "success.main",
                  "&:hover": {
                    borderColor: "success.light",
                    bgcolor: "rgba(90, 154, 90, 0.08)",
                  },
                }}
              >
                Resume
              </Button>
            )}
            {(run.status === "running" || run.status === "paused") && (
              <Button
                variant="outlined"
                size="small"
                color="error"
                startIcon={
                  actionLoading === "cancel" ? (
                    <CircularProgress size={14} color="inherit" />
                  ) : (
                    <Stop fontSize="small" />
                  )
                }
                onClick={handleCancel}
                disabled={actionLoading !== null}
                sx={{
                  textTransform: "none",
                  letterSpacing: 0,
                  fontWeight: 500,
                  borderColor: "error.main",
                  color: "error.main",
                  "&:hover": {
                    borderColor: "error.light",
                    bgcolor: "rgba(184, 74, 58, 0.08)",
                  },
                }}
              >
                Cancel
              </Button>
            )}
          </Box>
        </Stack>
      </Box>

      {/* ── Board ── */}

      {/* ── Card Status Filter ── */}
      <Box
        sx={{
          px: 3,
          py: 1.25,
          borderBottom: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
          animation: "fadeInUp 300ms ease",
        }}
      >
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              fontWeight: 600,
              mr: 0.5,
            }}
          >
            Filter
          </Typography>
          {[
            { key: null, label: "All" },
            { key: "todo", label: "Todo", color: LANE_STATUS_COLORS.todo },
            { key: "running", label: "Running", color: LANE_STATUS_COLORS.running },
            { key: "done", label: "Done", color: LANE_STATUS_COLORS.done },
            { key: "failed", label: "Failed", color: LANE_STATUS_COLORS.failed },
          ].map((opt) => (
            <Chip
              key={opt.key ?? "all"}
              label={opt.label}
              size="small"
              variant={cardStatusFilter === opt.key ? "filled" : "outlined"}
              onClick={() => setCardStatusFilter(opt.key)}
              sx={{
                textTransform: "none",
                letterSpacing: 0,
                fontWeight: cardStatusFilter === opt.key ? 600 : 400,
                fontSize: "0.75rem",
                height: 26,
                ...(cardStatusFilter === opt.key && opt.color
                  ? {
                      bgcolor: `${opt.color}22`,
                      borderColor: opt.color,
                      color: opt.color,
                    }
                  : {}),
                "&:hover": {
                  bgcolor: opt.color ? `${opt.color}12` : "rgba(208, 216, 200, 0.08)",
                },
              }}
            />
          ))}
        </Stack>
      </Box>

      {/* ── Board ── */}
      <Box
        sx={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: `repeat(${Math.min(lanes.length, 6)}, minmax(0, 1fr))`,
          gap: 1.75,
          p: 2.5,
          overflow: "hidden",
          minHeight: 0,
          "@media (max-width: 1100px)": {
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            overflowY: "auto",
          },
          "@media (max-width: 720px)": {
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          },
          "@media (max-width: 480px)": {
            gridTemplateColumns: "1fr",
          },
        }}
      >
        {lanes.map((lane, idx) => (
          <Box
            key={lane.agent}
            sx={{
              animation: "fadeInUp 400ms ease",
              animationDelay: `${idx * 80}ms`,
              animationFillMode: "backwards",
            }}
          >
            <LaneColumn lane={lane} onCardClick={openCardDetail} cardStatusFilter={cardStatusFilter} />
          </Box>
        ))}
      </Box>

      {/* ── Currently Working On ── */}
      {run.status === "running" && snapshot.currentStoryId && (
        <Box
          sx={{
            px: 2.5,
            pb: 1,
            animation: "fadeInUp 300ms ease",
          }}
        >
          <Box
            sx={{
              bgcolor: "rgba(200, 168, 74, 0.06)",
              border: 1,
              borderColor: "rgba(200, 168, 74, 0.2)",
              borderRadius: 1.5,
              px: 2,
              py: 1.25,
            }}
          >
            <Stack direction="row" spacing={1.5} alignItems="center">
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  bgcolor: "#c8a84a",
                  animation: "pulse 1.8s infinite",
                  flexShrink: 0,
                }}
              />
              <Typography
                variant="caption"
                sx={{
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "warning.main",
                }}
              >
                Currently working on
              </Typography>
              <Typography
                variant="body2"
                sx={{
                  fontFamily: '"JetBrains Mono", monospace',
                  fontWeight: 500,
                }}
              >
                {snapshot.currentStoryId}
              </Typography>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {(() => {
                  for (const lane of lanes) {
                    for (const card of lane.cards) {
                      if (card.id === snapshot.currentStoryId) return card.title;
                    }
                  }
                  return "";
                })()}
              </Typography>
              <DoubleArrow
                sx={{
                  fontSize: 14,
                  color: "warning.main",
                  animation: "slideRight 1.2s infinite",
                  flexShrink: 0,
                }}
              />
            </Stack>
          </Box>
        </Box>
      )}

      {/* ── Chat Activity Feed (floating) ── */}
      <Box
        sx={{
          position: "fixed",
          bottom: 16,
          right: 16,
          zIndex: 1200,
          width: 400,
          maxWidth: "calc(100vw - 32px)",
          animation: "fadeInUp 400ms ease",
        }}
      >
        <Box
          sx={{
            border: 1,
            borderColor: "divider",
            borderRadius: 1.5,
            bgcolor: "rgba(22, 32, 26, 0.94)",
            backdropFilter: "blur(10px)",
            overflow: "hidden",
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          }}
        >
          {/* Header */}
          <Box
            sx={{
              px: 2,
              py: 1,
              borderBottom: 1,
              borderColor: "divider",
              display: "flex",
              alignItems: "center",
              gap: 1,
            }}
          >
            <SmartToy sx={{ fontSize: 15, color: "#c8a84a" }} />
            <Typography
              variant="caption"
              sx={{
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "text.secondary",
              }}
            >
              Activity
            </Typography>
            {run.status === "running" && (
              <Box
                sx={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  bgcolor: "success.main",
                  animation: "pulse 1.8s infinite",
                }}
              />
            )}
            <Typography
              variant="caption"
              color="text.disabled"
              sx={{
                ml: "auto",
                textTransform: "none",
                letterSpacing: 0,
              }}
            >
              {chatEvents.length} events
            </Typography>
          </Box>

          {/* Chat messages */}
          <Box
            ref={chatRef}
            sx={{
              maxHeight: 280,
              overflowY: "auto",
              scrollBehavior: "smooth",
            }}
          >
            {chatEvents.length === 0 ? (
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  minHeight: 80,
                  color: "text.disabled",
                  fontStyle: "italic",
                  fontSize: "0.75rem",
                }}
              >
                Waiting for activity...
              </Box>
            ) : (
              <Box sx={{ py: 0.5 }}>
                {chatEvents.map((evt, i) => {
                  const msg = formatChatEvent(evt);
                  return (
                    <ChatMessage
                      key={msg.id}
                      msg={msg}
                      isLatest={i === chatEvents.length - 1}
                    />
                  );
                })}
              </Box>
            )}
          </Box>
        </Box>
      </Box>

      {/* ── Card Detail Dialog ── */}
      <Dialog
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        maxWidth="md"
        fullWidth
        PaperProps={{
          sx: {
            bgcolor: "background.paper",
            backgroundImage: "none",
            borderRadius: 2,
          },
        }}
      >
        {cardDetail && (
          <>
            <DialogTitle sx={{ pb: 1 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                    <Box
                      sx={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        bgcolor: CARD_STATUS_COLORS[cardDetail.status] ?? "#7a8a72",
                        flexShrink: 0,
                      }}
                    />
                    <Typography
                      variant="body2"
                      sx={{ fontFamily: '"JetBrains Mono", monospace', fontWeight: 600 }}
                    >
                      {cardDetail.cardId}
                    </Typography>
                    <Chip
                      label={cardDetail.status}
                      size="small"
                      variant="outlined"
                      sx={{
                        fontSize: "0.6875rem",
                        borderColor: `${CARD_STATUS_COLORS[cardDetail.status] ?? "#7a8a72"}55`,
                        color: CARD_STATUS_COLORS[cardDetail.status] ?? "#7a8a72",
                      }}
                    />
                    {cardDetail.retryCount > 0 && cardDetail.retryCount < cardDetail.maxRetries && (
                      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ ml: 0.5 }}>
                        <Replay sx={{ fontSize: 12, color: "warning.main" }} />
                        <Typography variant="caption" color="warning.main" sx={{ textTransform: "none", letterSpacing: 0 }}>
                          {cardDetail.retryCount}/{cardDetail.maxRetries}
                        </Typography>
                      </Stack>
                    )}
                    {cardDetail.retryCount > 0 && cardDetail.retryCount >= cardDetail.maxRetries && (
                      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ ml: 0.5 }}>
                        <ErrorOutline sx={{ fontSize: 12, color: "error.main" }} />
                        <Typography variant="caption" color="error.main" sx={{ textTransform: "none", letterSpacing: 0, fontWeight: 600 }}>
                          Retries exhausted ({cardDetail.retryCount}/{cardDetail.maxRetries})
                        </Typography>
                      </Stack>
                    )}
                  </Stack>
                  <Typography variant="body1" sx={{ fontWeight: 500, mt: 0.5 }}>
                    {cardDetail.title}
                  </Typography>
                </Box>
                <IconButton size="small" onClick={() => setDetailOpen(false)} sx={{ ml: 1, flexShrink: 0 }}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              </Stack>
            </DialogTitle>
            <DialogContent dividers sx={{ borderColor: "divider" }}>
              {/* Retries exhausted banner */}
              {cardDetail.retryCount > 0 && cardDetail.retryCount >= cardDetail.maxRetries && (
                <Box
                  sx={{
                    bgcolor: "rgba(184, 74, 58, 0.08)",
                    border: 1,
                    borderColor: "rgba(184, 74, 58, 0.25)",
                    borderRadius: 1,
                    px: 1.5,
                    py: 1,
                    mb: 2,
                  }}
                >
                  <Stack direction="row" spacing={1} alignItems="center">
                    <ErrorOutline sx={{ fontSize: 16, color: "error.main" }} />
                    <Box>
                      <Typography variant="body2" color="error.main" sx={{ fontWeight: 600, textTransform: "none", letterSpacing: 0 }}>
                        Retries exhausted
                      </Typography>
                      <Typography variant="caption" color="error.main" sx={{ opacity: 0.8, textTransform: "none", letterSpacing: 0 }}>
                        This card will not be retried. The run has failed after {cardDetail.retryCount} attempt{cardDetail.retryCount > 1 ? "s" : ""}.
                      </Typography>
                    </Box>
                  </Stack>
                </Box>
              )}

              <Stack spacing={2.5}>
                {/* Description */}
                {cardDetail.description && (
                  <Box>
                    <Typography variant="caption" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, mb: 0.5, display: "block" }}>
                      Description
                    </Typography>
                    <Typography variant="body2" sx={{ lineHeight: 1.6 }}>
                      {cardDetail.description}
                    </Typography>
                  </Box>
                )}

                {/* Acceptance Criteria */}
                {cardDetail.acceptanceCriteria && cardDetail.acceptanceCriteria.length > 0 && (
                  <Box>
                    <Typography variant="caption" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, mb: 0.5, display: "block" }}>
                      Acceptance Criteria
                    </Typography>
                    <Box component="ul" sx={{ mt: 0, pl: 2, m: 0 }}>
                      {cardDetail.acceptanceCriteria.map((c, i) => (
                        <Typography key={i} variant="body2" component="li" sx={{ mb: 0.25, lineHeight: 1.5 }}>
                          {c}
                        </Typography>
                      ))}
                    </Box>
                  </Box>
                )}

                {/* Input Template */}
                {cardDetail.input_template && (
                  <Box>
                    <Typography variant="caption" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, mb: 0.5, display: "block" }}>
                      Input Template
                    </Typography>
                    <Box
                      sx={{
                        p: 1.25,
                        bgcolor: "rgba(0,0,0,0.2)",
                        border: 1,
                        borderColor: "divider",
                        borderRadius: 1,
                        maxHeight: 300,
                        overflow: "auto",
                      }}
                    >
                      <MarkdownRenderer content={cardDetail.input_template} />
                    </Box>
                  </Box>
                )}

                {/* Output */}
                {cardDetail.output && (
                  <Box>
                    <Typography variant="caption" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, mb: 0.5, display: "block" }}>
                      Output
                    </Typography>
                    <Box
                      sx={{
                        p: 1.25,
                        bgcolor: "rgba(0,0,0,0.2)",
                        border: 1,
                        borderColor: "divider",
                        borderRadius: 1,
                        maxHeight: 500,
                        overflow: "auto",
                      }}
                    >
                      <MarkdownRenderer content={cardDetail.output} />
                    </Box>
                  </Box>
                )}

                {/* Failure Detail */}
                {cardDetail.failureDetail && (
                  <Box>
                    <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 0.5 }}>
                      <ErrorOutline sx={{ fontSize: 14, color: "error.main" }} />
                      <Typography variant="caption" color="error.main" sx={{ textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
                        Failure Detail
                      </Typography>
                    </Stack>
                    <Box
                      component="pre"
                      sx={{
                        m: 0,
                        p: 1.25,
                        bgcolor: "rgba(184, 74, 58, 0.06)",
                        border: 1,
                        borderColor: "rgba(184, 74, 58, 0.25)",
                        borderRadius: 1,
                        fontFamily: '"JetBrains Mono", monospace',
                        fontSize: "0.6875rem",
                        lineHeight: 1.5,
                        color: "error.main",
                        maxHeight: 200,
                        overflow: "auto",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {cardDetail.failureDetail}
                    </Box>
                  </Box>
                )}

                {/* Timing */}
                {cardDetail.timing && (
                  <Box>
                    <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 0.5 }}>
                      <AccessTime sx={{ fontSize: 14, color: "text.secondary" }} />
                      <Typography variant="caption" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
                        Timing
                      </Typography>
                    </Stack>
                    <Stack
                      direction={{ xs: "column", sm: "row" }}
                      spacing={{ xs: 0.5, sm: 2.5 }}
                      sx={{ pl: 0.25 }}
                    >
                      <Typography variant="body2" color="text.secondary" noWrap>
                        <Box component="span" color="text.primary">First:</Box>{" "}
                        <Box component="span" sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: "0.6875rem" }}>
                          {fmtTime(cardDetail.timing.firstEvent)}
                        </Box>
                      </Typography>
                      <Typography variant="body2" color="text.secondary" noWrap>
                        <Box component="span" color="text.primary">Last:</Box>{" "}
                        <Box component="span" sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: "0.6875rem" }}>
                          {fmtTime(cardDetail.timing.lastEvent)}
                        </Box>
                      </Typography>
                      <Typography variant="body2" color="text.secondary" noWrap>
                        <Box component="span" color="text.primary">Duration:</Box>{" "}
                        <Box component="span" sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: "0.6875rem" }}>
                          {fmtElapsed(Math.floor(cardDetail.timing.durationMs / 1000))}
                        </Box>
                      </Typography>
                    </Stack>
                  </Box>
                )}

                {/* Tokens */}
                {cardDetail.tokens && (
                  <Box>
                    <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 0.5 }}>
                      <TokenIcon sx={{ fontSize: 14, color: "text.secondary" }} />
                      <Typography variant="caption" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
                        Tokens
                      </Typography>
                    </Stack>
                    <Typography
                      variant="body2"
                      sx={{ fontFamily: '"JetBrains Mono", monospace', pl: 0.25 }}
                    >
                      Total: {cardDetail.tokens.total?.toLocaleString() ?? "—"}
                    </Typography>
                  </Box>
                )}
              </Stack>
            </DialogContent>
            <DialogActions sx={{ px: 2, py: 1.5 }}>
              <Button onClick={() => setDetailOpen(false)} variant="outlined" size="small">
                Close
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </Box>
  );
}
