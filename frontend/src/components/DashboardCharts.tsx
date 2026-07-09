import { useMemo } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import IconButton from "@mui/material/IconButton";
import InfoOutlined from "@mui/icons-material/InfoOutlined";
import { PieChart } from "@mui/x-charts/PieChart";
import { BarChart } from "@mui/x-charts/BarChart";
import { LineChart } from "@mui/x-charts/LineChart";
import type { Run, TamanduaEvent, AutoresearchSession } from "../api/client";

// ── Color palette matching the tamandua theme ──

const C = {
  running: "#c8a84a",
  completed: "#5a9a5a",
  failed: "#b84a3a",
  canceled: "#7a8a72",
  paused: "#c8a84a",
  blocked: "#b85a3a",
  waiting: "#4a6a5a",
  gold: "#c8a84a",
  goldLight: "#e0c86a",
  text: "#7a8a72",
  textPrimary: "#d0d8c8",
  grid: "rgba(208, 216, 200, 0.06)",
};

const STATUS_LABELS: Record<string, string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  canceled: "Canceled",
  paused: "Paused",
  blocked: "Blocked",
};

// ── Chart Section Wrapper ───────────────────────────────────────────

function ChartCard({
  title,
  subtitle,
  info,
  children,
  height = 220,
}: {
  title: string;
  subtitle?: string;
  info?: string;
  children: React.ReactNode;
  height?: number;
}) {
  return (
    <Box
      sx={{
        flex: "1 1 0",
        minWidth: 0,
        border: "1px solid rgba(208, 216, 200, 0.08)",
        borderRadius: 2,
        p: 2,
        transition: "border-color 200ms ease",
        "&:hover": { borderColor: "rgba(200, 168, 74, 0.2)" },
      }}
    >
      <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 0.25 }}>
        <Typography variant="h3">{title}</Typography>
        {info && (
          <Tooltip title={info} arrow placement="top">
            <IconButton size="small" sx={{ opacity: 0.4, "&:hover": { opacity: 0.8 } }}>
              <InfoOutlined fontSize="inherit" />
            </IconButton>
          </Tooltip>
        )}
      </Stack>
      {subtitle && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ mb: 1.5, display: "block", textTransform: "none", letterSpacing: 0 }}
        >
          {subtitle}
        </Typography>
      )}
      <Box sx={{ width: "100%", height }}>{children}</Box>
    </Box>
  );
}

// ── 1. Run Status Donut ─────────────────────────────────────────────

function RunStatusChart({ runs }: { runs: Run[] }) {
  const data = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of runs) {
      counts[r.status] = (counts[r.status] ?? 0) + 1;
    }
    return Object.entries(counts)
      .map(([status, value]) => ({
        id: status,
        label: STATUS_LABELS[status] ?? status,
        value,
        color: C[status as keyof typeof C] ?? "#7a8a72",
      }))
      .sort((a, b) => b.value - a.value);
  }, [runs]);

  if (data.length === 0) return null;

  const total = data.reduce((s, d) => s + d.value, 0);

  return (
    <ChartCard title="Run Status" subtitle={`${total} total runs`} height={220}>
      <PieChart
        series={[
          {
            data,
            innerRadius: 48,
            outerRadius: 80,
            paddingAngle: 2,
            cornerRadius: 3,
            arcLabel: (item) => (item.value > 0 ? `${item.value}` : ""),
            arcLabelMinAngle: 20,
          },
        ]}
        slotProps={{
          legend: {
            direction: "horizontal",
            position: { vertical: "bottom", horizontal: "center" },
          },
        }}
        margin={{ top: 20, right: 4, bottom: 48, left: 4 }}
      />
    </ChartCard>
  );
}

// ── 2. Token Usage (line, per minute) ────────────────────────────────

function TokenUsageLineChart({ events }: { events: TamanduaEvent[] }) {
  const dataset = useMemo(() => {
    // Filter events with tokenDelta, accumulate by minute
    const byMinute: Map<string, number> = new Map();
    let cumulative = 0;
    for (const evt of events) {
      if (evt.tokenDelta == null) continue;
      cumulative += evt.tokenDelta;
      const minute = evt.ts.slice(0, 16);
      byMinute.set(minute, cumulative);
    }

    const entries = Array.from(byMinute.entries()).sort(([a], [b]) => a.localeCompare(b));

    if (entries.length === 0) return [];

    // Build continuous timeline
    const start = entries[0][0];
    const end = entries[entries.length - 1][0];
    const filled: { time: string; tokens: number }[] = [];

    const [startDate, startTime] = start.split("T");
    let [h, m] = startTime.split(":").map(Number);
    let currentDate = startDate;

    while (`${currentDate}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` <= end) {
      const key = `${currentDate}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      const val = byMinute.get(key);
      filled.push({
        time: key.slice(11, 16),
        tokens: val ?? (filled.length > 0 ? filled[filled.length - 1].tokens : 0),
      });
      m++;
      if (m >= 60) { m = 0; h++; }
      if (h >= 24) { h = 0;
        const d = new Date(currentDate);
        d.setDate(d.getDate() + 1);
        currentDate = d.toISOString().slice(0, 10);
      }
    }

    return filled;
  }, [events]);

  if (dataset.length === 0) return null;

  const total = dataset[dataset.length - 1].tokens;

  return (
    <ChartCard
      title="Token Usage"
      subtitle={`${total.toLocaleString()} tokens cumulative \u00b7 ${dataset.length} min span`}
      info="Based on the last 500 events with token data. May not reflect all historical runs."
      height={220}
    >
      <LineChart
        dataset={dataset}
        xAxis={[
          {
            dataKey: "time",
            scaleType: "band",
            tickLabelStyle: { fontSize: 9, fill: C.text },
          },
        ]}
        yAxis={[
          {
            tickLabelStyle: { fontSize: 10, fill: C.text },
            valueFormatter: (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)),
          },
        ]}
        series={[
          {
            dataKey: "tokens",
            label: "Tokens (cumulative)",
            color: C.gold,
            showMark: false,
            area: true,
            valueFormatter: (v: number | null) => (v ?? 0).toLocaleString(),
          },
        ]}
        hideLegend
        margin={{ top: 8, right: 8, bottom: 36, left: 44 }}
        grid={{ vertical: false, horizontal: true }}
      />
    </ChartCard>
  );
}

// ── 3. Daily Run Activity ──────────────────────────────────────────

function DailyRunActivityChart({ runs }: { runs: Run[] }) {
  const dataset = useMemo(() => {
    const byDay: Record<string, { created: number }> = {};
    for (const r of runs) {
      if (!r.created_at) continue;
      const day = r.created_at.slice(0, 10);
      if (!byDay[day]) byDay[day] = { created: 0 };
      byDay[day].created++;
    }
    return Object.entries(byDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-14)
      .map(([day, counts]) => ({
        day: day.slice(5),
        ...counts,
      }));
  }, [runs]);

  if (dataset.length === 0) return null;

  return (
    <ChartCard title="Daily Activity" subtitle="Runs created per day (last 14 days)" height={220}>
      <BarChart
        dataset={dataset}
        xAxis={[{ dataKey: "day", scaleType: "band", tickLabelStyle: { fontSize: 10, fill: C.text } }]}
        yAxis={[{ tickLabelStyle: { fontSize: 10, fill: C.text }, tickMinStep: 1 }]}
        series={[
          {
            dataKey: "created",
            label: "Created",
            color: C.gold,
          },
        ]}
        hideLegend
        margin={{ top: 4, right: 8, bottom: 24, left: 40 }}
        grid={{ vertical: false, horizontal: true }}
      />
    </ChartCard>
  );
}

// ── 4. AutoResearch Metric Progress ─────────────────────────────────

function AutoResearchChart({ sessions }: { sessions: AutoresearchSession[] }) {
  const dataset = useMemo(() => {
    return sessions
      .filter((s) => s.total_runs > 1 && s.baseline_metric != null && s.best_metric != null)
      .slice(0, 10)
      .map((s) => ({
        name: s.goal.length > 28 ? s.goal.slice(0, 25) + "…" : s.goal,
        baseline: Number(s.baseline_metric!.toFixed(4)),
        best: Number(s.best_metric!.toFixed(4)),
      }));
  }, [sessions]);

  if (dataset.length === 0) return null;

  return (
    <ChartCard title="AutoResearch" subtitle="Baseline vs best metric per session" height={260}>
      <BarChart
        dataset={dataset}
        xAxis={[
          {
            dataKey: "name",
            scaleType: "band",
            tickLabelStyle: { fontSize: 10, fill: C.textPrimary },
          },
        ]}
        yAxis={[{ tickLabelStyle: { fontSize: 10, fill: C.text } }]}
        series={[
          { dataKey: "baseline", label: "Baseline", color: C.text },
          { dataKey: "best", label: "Best", color: C.gold },
        ]}
        slotProps={{
          legend: {
            direction: "horizontal",
            position: { vertical: "bottom", horizontal: "center" },
          },
        }}
        margin={{ top: 4, right: 8, bottom: 48, left: 40 }}
        grid={{ vertical: false, horizontal: true }}
      />
    </ChartCard>
  );
}

// ── 5. Steps Completion Rate ────────────────────────────────────────

function StepsProgressChart({ runs }: { runs: Run[] }) {
  const data = useMemo(() => {
    const total = { completed: 0, failed: 0, running: 0, waiting: 0 };
    for (const r of runs) {
      total.completed += r.completed_steps ?? 0;
      total.failed += r.failed_steps ?? 0;
      total.running += r.running_steps ?? 0;
      total.waiting += r.waiting_steps ?? 0;
    }
    return [
      { id: "done", label: "Done", value: total.completed, color: C.completed },
      { id: "failed", label: "Failed", value: total.failed, color: C.failed },
      { id: "running", label: "Running", value: total.running, color: C.running },
      { id: "waiting", label: "Waiting", value: total.waiting, color: C.waiting },
    ].filter((d) => d.value > 0);
  }, [runs]);

  if (data.length === 0) return null;

  const total = data.reduce((s, d) => s + d.value, 0);

  return (
    <ChartCard title="Steps Overview" subtitle={`${total} total steps across all runs`} height={220}>
      <PieChart
        series={[
          {
            data,
            innerRadius: 48,
            outerRadius: 80,
            paddingAngle: 2,
            cornerRadius: 3,
            arcLabel: (item) => (item.value > 0 ? `${item.value}` : ""),
            arcLabelMinAngle: 20,
          },
        ]}
        slotProps={{
          legend: {
            direction: "horizontal",
            position: { vertical: "bottom", horizontal: "center" },
          },
        }}
        margin={{ top: 20, right: 4, bottom: 48, left: 4 }}
      />
    </ChartCard>
  );
}

// ── 6. Token Efficiency ─────────────────────────────────────────────

function TokenEfficiencyChart({ runs }: { runs: Run[] }) {
  const dataset = useMemo(() => {
    return runs
      .filter((r) => r.completed_steps > 0 && r.tokens_spent > 0)
      .slice(0, 20)
      .map((r) => ({
        name: `#${r.run_number ?? r.id.slice(0, 6)}`,
        efficiency: Math.round(r.tokens_spent / r.completed_steps),
      }))
      .reverse();
  }, [runs]);

  if (dataset.length === 0) return null;

  return (
    <ChartCard title="Token Efficiency" subtitle="Tokens per completed step (last 20 runs)" height={220}>
      <BarChart
        dataset={dataset}
        xAxis={[
          {
            dataKey: "name",
            scaleType: "band",
            tickLabelStyle: { fontSize: 9, fill: C.text },
          },
        ]}
        yAxis={[{ tickLabelStyle: { fontSize: 10, fill: C.text } }]}
        series={[
          {
            dataKey: "efficiency",
            label: "Tokens/step",
            color: C.goldLight,
            valueFormatter: (v: number | null) => (v ?? 0).toLocaleString(),
          },
        ]}
        hideLegend
        margin={{ top: 4, right: 8, bottom: 24, left: 40 }}
        grid={{ vertical: false, horizontal: true }}
      />
    </ChartCard>
  );
}

// ── Main Export ──────────────────────────────────────────────────────

interface DashboardChartsProps {
  runs: Run[];
  events: TamanduaEvent[];
  autoresearchSessions: AutoresearchSession[];
}

export default function DashboardCharts({ runs, events, autoresearchSessions }: DashboardChartsProps) {
  const hasRuns = runs.length > 0;
  const hasSessions = autoresearchSessions.length > 0;
  const hasTokenEvents = events.some((e) => e.tokenDelta != null);

  if (!hasRuns && !hasSessions) return null;

  return (
    <Box sx={{ mb: 3 }}>
      <Stack
        direction={{ xs: "column", md: "row" }}
        spacing={2}
        sx={{
          mb: 2,
          animation: "fadeInUp 400ms ease",
          animationDelay: "40ms",
          animationFillMode: "backwards",
        }}
      >
        {hasRuns && <RunStatusChart runs={runs} />}
        {hasRuns && <StepsProgressChart runs={runs} />}
        {hasTokenEvents && <TokenUsageLineChart events={events} />}
      </Stack>

      <Stack
        direction={{ xs: "column", md: "row" }}
        spacing={2}
        sx={{
          animation: "fadeInUp 400ms ease",
          animationDelay: "120ms",
          animationFillMode: "backwards",
        }}
      >
        {hasRuns && <DailyRunActivityChart runs={runs} />}
        {hasRuns && <TokenEfficiencyChart runs={runs} />}
        {hasSessions && <AutoResearchChart sessions={autoresearchSessions} />}
      </Stack>
    </Box>
  );
}
