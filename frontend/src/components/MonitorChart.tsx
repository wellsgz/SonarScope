import ReactECharts from "echarts-for-react";
import { Component, useMemo, type ReactNode } from "react";
import type { TimeSeriesPoint, TimeSeriesResponse } from "../types/api";

type Props = {
  points: TimeSeriesPoint[];
  endpointLabel: string;
  rollup: TimeSeriesResponse["rollup"];
  rangeStart: Date;
  rangeEnd: Date;
  snapshotCapturedAt: Date;
  snapshotVersion: number;
  controlsChanged?: boolean;
};

type ChartErrorBoundaryProps = {
  resetKey: string;
  children: ReactNode;
};

type ChartErrorBoundaryState = {
  hasError: boolean;
};

const LATENCY_SERIES_COLOR = "#2563EB";

class ChartErrorBoundary extends Component<ChartErrorBoundaryProps, ChartErrorBoundaryState> {
  state: ChartErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ChartErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error("monitor chart render failed", error);
  }

  componentDidUpdate(prevProps: ChartErrorBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return <div className="state-panel chart-empty-series-panel">The chart failed to render for this snapshot.</div>;
    }
    return this.props.children;
  }
}

function readToken(name: string, fallback: string): string {
  if (typeof window === "undefined") {
    return fallback;
  }
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function readTokenFontSizePx(name: string, fallbackRem: number): number {
  if (typeof window === "undefined") {
    return fallbackRem * 16;
  }
  const rootStyles = getComputedStyle(document.documentElement);
  const rawValue = rootStyles.getPropertyValue(name).trim();
  const rootFontSizePx = Number.parseFloat(rootStyles.fontSize) || 16;
  const candidate = rawValue || `${fallbackRem}rem`;

  if (candidate.endsWith("rem")) {
    const rem = Number.parseFloat(candidate);
    if (Number.isFinite(rem)) {
      return rem * rootFontSizePx;
    }
  }

  if (candidate.endsWith("px")) {
    const px = Number.parseFloat(candidate);
    if (Number.isFinite(px)) {
      return px;
    }
  }

  const parsed = Number.parseFloat(candidate);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return fallbackRem * rootFontSizePx;
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function formatLatency(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function formatLatencyAxis(value: number): string {
  return `${value.toFixed(0)} ms`;
}

function formatChartRangeLabel(rangeStart: Date, rangeEnd: Date): string {
  const startMs = rangeStart.getTime();
  const endMs = rangeEnd.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return "Chart range: unavailable";
  }

  const sameDay = rangeStart.toDateString() === rangeEnd.toDateString();
  const dateFormatter = new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    year: "numeric"
  });
  const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
  const timeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  });

  const startLabel = dateTimeFormatter.format(rangeStart);
  const endLabel = sameDay ? timeFormatter.format(rangeEnd) : dateTimeFormatter.format(rangeEnd);
  const dayLabel = sameDay ? ` (${dateFormatter.format(rangeStart)})` : "";

  return `Chart range: ${startLabel} - ${endLabel}${dayLabel} (local)`;
}

function formatSnapshotLabel(capturedAt: Date): string {
  if (Number.isNaN(capturedAt.getTime())) {
    return "Snapshot captured: unavailable";
  }
  return `Snapshot captured: ${new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(capturedAt)} (local)`;
}

function buildSeriesPoints(points: TimeSeriesPoint[], metric: "loss_rate" | "avg_latency_ms") {
  return points
    .filter((point) => point.sent_count > 0)
    .map((point) => {
      const timestamp = new Date(point.bucket).getTime();
      const value = metric === "loss_rate" ? point.loss_rate : point.avg_latency_ms;
      if (!Number.isFinite(timestamp) || typeof value !== "number" || !Number.isFinite(value)) {
        return null;
      }
      return [timestamp, value] as [number, number];
    })
    .filter((point): point is [number, number] => point !== null);
}

function resolveLossColor(lossPoints: Array<[number, number]>, success: string, danger: string): string {
  const latest = lossPoints.length > 0 ? lossPoints[lossPoints.length - 1][1] : null;
  if (latest === null) {
    return success;
  }
  return latest <= 0 ? success : danger;
}

export function MonitorChart({
  points,
  endpointLabel,
  rollup,
  rangeStart,
  rangeEnd,
  snapshotCapturedAt,
  snapshotVersion,
  controlsChanged = false
}: Props) {
  const chartRangeLabel = useMemo(() => formatChartRangeLabel(rangeStart, rangeEnd), [rangeStart, rangeEnd]);
  const snapshotLabel = useMemo(() => formatSnapshotLabel(snapshotCapturedAt), [snapshotCapturedAt]);
  const rangeStartMs = rangeStart.getTime();
  const rangeEndMs = rangeEnd.getTime();
  const hasProbeActivity = useMemo(() => points.some((point) => point.sent_count > 0), [points]);
  const lossSeries = useMemo(() => buildSeriesPoints(points, "loss_rate"), [points]);
  const latencySeries = useMemo(() => buildSeriesPoints(points, "avg_latency_ms"), [points]);
  const hasRenderableSeries = lossSeries.length > 0 || latencySeries.length > 0;

  const palette = {
    textMuted: readToken("--color-text-muted", "#b4c3db"),
    textSubtle: readToken("--color-text-subtle", "#94a7c4"),
    border: readToken("--color-border", "#21324d"),
    success: readToken("--color-success", "#10b981"),
    danger: readToken("--color-danger", "#ef4444")
  };
  const legendFontSizePx = readTokenFontSizePx("--text-sm", 0.74);

  const option = useMemo(() => {
    const lossColor = resolveLossColor(lossSeries, palette.success, palette.danger);
    const maxLatency = latencySeries.reduce((acc, [, value]) => Math.max(acc, value), 0);
    const latencyAxisMax = Math.max(20, Math.ceil(maxLatency / 20) * 20);

    return {
      animation: false,
      backgroundColor: "transparent",
      tooltip: {
        trigger: "axis",
        formatter: (rawParams: unknown) => {
          const params = (Array.isArray(rawParams) ? rawParams : [rawParams]) as Array<{
            axisValue?: number | string;
            seriesName?: string;
            value?: unknown;
          }>;
          if (params.length === 0) {
            return "";
          }

          const axisValue = params[0]?.axisValue;
          const timestamp = typeof axisValue === "number" ? axisValue : new Date(axisValue ?? "").getTime();
          const header = Number.isNaN(timestamp)
            ? String(axisValue ?? "")
            : new Intl.DateTimeFormat(undefined, {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit"
              }).format(new Date(timestamp));

          let lossValue: number | null = null;
          let latencyValue: number | null = null;
          for (const param of params) {
            const value = Array.isArray(param.value) ? param.value[1] : null;
            if (typeof value !== "number" || !Number.isFinite(value)) {
              continue;
            }
            if (param.seriesName === "Loss %") {
              lossValue = value;
            }
            if (param.seriesName === "Latency") {
              latencyValue = value;
            }
          }

          return [header, `Loss Rate: ${lossValue === null ? "—" : formatPercent(lossValue)}`, `Latency: ${latencyValue === null ? "—" : formatLatency(latencyValue)}`].join(
            "<br/>"
          );
        }
      },
      legend: {
        data: ["Loss %", "Latency"],
        textStyle: { color: palette.textMuted, fontSize: legendFontSizePx }
      },
      grid: {
        left: 64,
        right: 56,
        top: 36,
        bottom: 38
      },
      xAxis: {
        type: "time",
        min: rangeStartMs,
        max: rangeEndMs,
        axisLabel: { color: palette.textSubtle },
        axisLine: { lineStyle: { color: palette.border } },
        splitLine: { lineStyle: { color: palette.border } }
      },
      yAxis: [
        {
          type: "value",
          name: "Loss Rate (%)",
          min: 0,
          max: 100,
          interval: 10,
          axisLabel: {
            color: palette.textSubtle,
            formatter: (value: number) => formatPercent(value)
          },
          nameTextStyle: { color: palette.textMuted },
          splitLine: { lineStyle: { color: palette.border } }
        },
        {
          type: "value",
          name: "Latency (ms)",
          min: 0,
          max: latencyAxisMax,
          interval: 20,
          axisLabel: {
            color: palette.textSubtle,
            formatter: (value: number) => formatLatencyAxis(value)
          },
          nameTextStyle: { color: palette.textMuted },
          splitLine: { show: false }
        }
      ],
      series: [
        {
          name: "Loss %",
          type: "line",
          smooth: true,
          showSymbol: false,
          connectNulls: false,
          yAxisIndex: 0,
          data: lossSeries,
          lineStyle: { width: 3, color: lossColor },
          itemStyle: { color: lossColor }
        },
        {
          name: "Latency",
          type: "line",
          smooth: true,
          showSymbol: false,
          connectNulls: false,
          yAxisIndex: 1,
          data: latencySeries,
          lineStyle: { width: 3, color: LATENCY_SERIES_COLOR },
          itemStyle: { color: LATENCY_SERIES_COLOR }
        }
      ]
    };
  }, [
    legendFontSizePx,
    latencySeries,
    lossSeries,
    palette.border,
    palette.danger,
    palette.success,
    palette.textMuted,
    palette.textSubtle,
    rangeEndMs,
    rangeStartMs
  ]);

  return (
    <div className="panel chart-panel">
      <div className="chart-header">
        <div>
          <div className="chart-title-row">
            <div className="chart-title">Loss &amp; Latency Timeline</div>
            <div className="chart-time-range" aria-label={chartRangeLabel}>
              {chartRangeLabel}
            </div>
          </div>
          <div className="chart-subtitle">Selected endpoint: {endpointLabel}</div>
          <div className="chart-subtitle">{snapshotLabel}</div>
          <div className="chart-subtitle">Rollup: {rollup}</div>
        </div>
      </div>
      {controlsChanged ? (
        <div className="info-banner chart-snapshot-note" role="status" aria-live="polite">
          Controls changed. Reselect an endpoint to refresh this chart snapshot.
        </div>
      ) : null}
      {!hasProbeActivity ? (
        <div className="info-banner chart-no-probe-banner" role="status" aria-live="polite">
          <span className="chart-no-probe-dot" aria-hidden />
          <span>No probe activity was recorded in this captured period.</span>
        </div>
      ) : null}
      <div className="chart-body">
        <ChartErrorBoundary resetKey={String(snapshotVersion)}>
          {!hasRenderableSeries ? (
            <div className="state-panel chart-empty-series-panel">
              No chart data is available for this captured snapshot.
            </div>
          ) : (
            <ReactECharts
              option={option}
              notMerge
              lazyUpdate
              className="chart-canvas"
              style={{ height: "100%", width: "100%" }}
            />
          )}
        </ChartErrorBoundary>
      </div>
    </div>
  );
}
