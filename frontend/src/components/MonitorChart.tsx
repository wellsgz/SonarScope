import ReactECharts from "echarts-for-react";
import { Component, useId, useMemo, type ReactNode } from "react";
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

type Metric = "loss_rate" | "avg_latency_ms";

type ChartPoint = {
  value: [number, number | null];
  meta: {
    metric: "loss" | "latency";
    missing: boolean;
    sentCount?: number;
    failCount?: number;
  };
};

type ChartErrorBoundaryProps = {
  resetKey: string;
  children: ReactNode;
};

type ChartErrorBoundaryState = {
  hasError: boolean;
};

const LATENCY_SERIES_COLOR = "#2563EB";
const NO_PROBE_LEGEND_NAME = "No probe period (dotted)";

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

function metricMeta(metric: Metric): "loss" | "latency" {
  return metric === "loss_rate" ? "loss" : "latency";
}

function toStepMs(rollup: TimeSeriesResponse["rollup"]): number {
  return rollup === "1h" ? 60 * 60 * 1000 : 60 * 1000;
}

function alignToStep(timestampMs: number, stepMs: number): number {
  return Math.floor(timestampMs / stepMs) * stepMs;
}

function alignStartToIncludedBucket(timestampMs: number, stepMs: number): number {
  return Math.ceil(timestampMs / stepMs) * stepMs;
}

function alignEndToIncludedBucket(timestampMs: number, stepMs: number): number {
  return Math.floor(timestampMs / stepMs) * stepMs;
}

function buildBuckets(rangeStart: Date, rangeEnd: Date, stepMs: number): number[] {
  const start = alignStartToIncludedBucket(rangeStart.getTime(), stepMs);
  const end = alignEndToIncludedBucket(rangeEnd.getTime(), stepMs);
  if (start > end) {
    return [];
  }
  const buckets: number[] = [];
  for (let current = start; current <= end; current += stepMs) {
    buckets.push(current);
  }
  return buckets;
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

function formatBucketLabel(bucket: string): string {
  const date = new Date(bucket);
  if (Number.isNaN(date.getTime())) {
    return "Unavailable";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function buildChartTextSummary(
  points: TimeSeriesPoint[],
  buckets: number[],
  rollup: TimeSeriesResponse["rollup"]
): {
  latestLossLabel: string;
  latestLatencyLabel: string;
  latestIntervalLabel: string;
  noProbeLabel: string;
} {
  const sortedMeasured = [...points]
    .filter((point) => point.sent_count > 0)
    .sort((left, right) => new Date(left.bucket).getTime() - new Date(right.bucket).getTime());
  const latestMeasured = sortedMeasured.length > 0 ? sortedMeasured[sortedMeasured.length - 1] : null;
  const pointByBucket = new Map<number, TimeSeriesPoint>();
  points.forEach((point) => {
    pointByBucket.set(alignToStep(new Date(point.bucket).getTime(), toStepMs(rollup)), point);
  });
  const noProbeCount = buckets.reduce((count, bucket) => {
    const point = pointByBucket.get(bucket);
    return count + (!point || point.sent_count === 0 ? 1 : 0);
  }, 0);
  const totalIntervals = buckets.length;

  return {
    latestLossLabel: latestMeasured ? formatPercent(latestMeasured.loss_rate) : "No probe data",
    latestLatencyLabel: latestMeasured
      ? latestMeasured.avg_latency_ms === null
        ? "—"
        : formatLatency(latestMeasured.avg_latency_ms)
      : "No probe data",
    latestIntervalLabel: latestMeasured
      ? `Latest measured interval: ${formatBucketLabel(latestMeasured.bucket)}`
      : "No measured intervals in the selected window.",
    noProbeLabel:
      totalIntervals === 0
        ? "No visible intervals for this range."
        : noProbeCount === 0
          ? "Probe activity was recorded in every visible interval."
          : noProbeCount === totalIntervals
            ? "No probe activity was recorded in this captured period."
            : `No probe activity in ${noProbeCount} of ${totalIntervals} visible intervals.`
  };
}

function buildMetricSeries(
  points: TimeSeriesPoint[],
  metric: Metric,
  buckets: number[],
  rollup: TimeSeriesResponse["rollup"],
  noProbeColor: string,
  latencyColor: string
) {
  const pointByBucket = new Map<number, TimeSeriesPoint>();
  points.forEach((point) => {
    pointByBucket.set(alignToStep(new Date(point.bucket).getTime(), toStepMs(rollup)), point);
  });

  const values: Array<number | null> = [];
  const noProbeFlags: boolean[] = [];
  const measuredData: Array<ChartPoint | [number, null]> = [];

  for (const bucket of buckets) {
    const point = pointByBucket.get(bucket);
    const isNoProbe = !point || point.sent_count === 0;
    const rawValue = point ? (metric === "loss_rate" ? point.loss_rate : point.avg_latency_ms) : null;
    const value = rawValue === null || rawValue === undefined ? null : rawValue;
    values.push(value);
    noProbeFlags.push(isNoProbe);

    if (isNoProbe || value === null) {
      measuredData.push([bucket, null]);
      continue;
    }

    measuredData.push({
      value: [bucket, value],
      meta: {
        metric: metricMeta(metric),
        missing: false,
        sentCount: point.sent_count,
        failCount: point.fail_count
      }
    });
  }

  const noProbeData: Array<ChartPoint | null> = [];
  const appendGap = (startIdx: number, endIdx: number, prevIdx: number, nextIdx: number) => {
    if (prevIdx >= 0 && nextIdx >= 0) {
      const prevVal = values[prevIdx];
      const nextVal = values[nextIdx];
      if (prevVal === null || nextVal === null) {
        return;
      }
      const span = Math.max(1, nextIdx - prevIdx);
      for (let idx = prevIdx; idx <= nextIdx; idx++) {
        const ratio = (idx - prevIdx) / span;
        const interpolated = prevVal + (nextVal - prevVal) * ratio;
        noProbeData.push({
          value: [buckets[idx], interpolated],
          meta: {
            metric: metricMeta(metric),
            missing: idx >= startIdx && idx <= endIdx
          }
        });
      }
      noProbeData.push(null);
      return;
    }

    if (prevIdx >= 0) {
      const prevVal = values[prevIdx];
      if (prevVal === null) {
        return;
      }
      for (let idx = prevIdx; idx <= endIdx; idx++) {
        noProbeData.push({
          value: [buckets[idx], prevVal],
          meta: {
            metric: metricMeta(metric),
            missing: idx >= startIdx && idx <= endIdx
          }
        });
      }
      noProbeData.push(null);
      return;
    }

    if (nextIdx >= 0) {
      const nextVal = values[nextIdx];
      if (nextVal === null) {
        return;
      }
      for (let idx = startIdx; idx <= nextIdx; idx++) {
        noProbeData.push({
          value: [buckets[idx], nextVal],
          meta: {
            metric: metricMeta(metric),
            missing: idx >= startIdx && idx <= endIdx
          }
        });
      }
      noProbeData.push(null);
    }
  };

  for (let idx = 0; idx < noProbeFlags.length; idx++) {
    if (!noProbeFlags[idx]) {
      continue;
    }
    const startIdx = idx;
    while (idx + 1 < noProbeFlags.length && noProbeFlags[idx + 1]) {
      idx++;
    }
    const endIdx = idx;

    let prevIdx = startIdx - 1;
    while (prevIdx >= 0 && values[prevIdx] === null) {
      prevIdx--;
    }
    let nextIdx = endIdx + 1;
    while (nextIdx < values.length && values[nextIdx] === null) {
      nextIdx++;
    }

    appendGap(startIdx, endIdx, prevIdx, nextIdx < values.length ? nextIdx : -1);
  }

  const measuredSeries = {
    name: metric === "loss_rate" ? "Loss %" : "Latency",
    type: "line",
    smooth: true,
    connectNulls: false,
    showSymbol: false,
    yAxisIndex: metric === "loss_rate" ? 0 : 1,
    lineStyle: metric === "loss_rate" ? { width: 3 } : { width: 3, color: latencyColor },
    data: measuredData
  };

  const noProbeSeries = {
    name: metric === "loss_rate" ? "No probe loss" : "No probe latency",
    type: "line",
    smooth: true,
    connectNulls: false,
    showSymbol: false,
    yAxisIndex: metric === "loss_rate" ? 0 : 1,
    lineStyle: { type: "dotted", width: 2, color: noProbeColor, opacity: 0.85 },
    itemStyle: { color: noProbeColor },
    data: noProbeData
  };

  return { measuredSeries, noProbeSeries };
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
  const chartSummaryId = useId();
  const chartRangeLabel = useMemo(() => formatChartRangeLabel(rangeStart, rangeEnd), [rangeStart, rangeEnd]);
  const snapshotLabel = useMemo(() => formatSnapshotLabel(snapshotCapturedAt), [snapshotCapturedAt]);
  const rangeStartMs = rangeStart.getTime();
  const rangeEndMs = rangeEnd.getTime();
  const hasProbeActivity = useMemo(() => points.some((point) => point.sent_count > 0), [points]);
  const buckets = useMemo(() => buildBuckets(rangeStart, rangeEnd, toStepMs(rollup)), [rangeEnd, rangeStart, rollup]);
  const chartTextSummary = useMemo(() => buildChartTextSummary(points, buckets, rollup), [buckets, points, rollup]);
  const palette = {
    textMuted: readToken("--color-text-muted", "#b4c3db"),
    textSubtle: readToken("--color-text-subtle", "#94a7c4"),
    border: readToken("--color-border", "#21324d"),
    success: "#22c55e",
    warning: "#f59e0b",
    danger: "#ef4444"
  };
  const legendFontSizePx = readTokenFontSizePx("--text-sm", 0.74);

  const loss = useMemo(
    () => buildMetricSeries(points, "loss_rate", buckets, rollup, palette.textSubtle, palette.success),
    [buckets, palette.success, palette.textSubtle, points, rollup]
  );
  const latency = useMemo(
    () => buildMetricSeries(points, "avg_latency_ms", buckets, rollup, palette.textSubtle, LATENCY_SERIES_COLOR),
    [buckets, palette.textSubtle, points, rollup]
  );
  const hasRenderableSeries = useMemo(() => {
    const lossMeasured = loss.measuredSeries.data as Array<ChartPoint | [number, null]>;
    const latencyMeasured = latency.measuredSeries.data as Array<ChartPoint | [number, null]>;
    const hasLoss = lossMeasured.some((point) => typeof point === "object" && point !== null && "meta" in point && !point.meta.missing);
    const hasLatency = latencyMeasured.some((point) => typeof point === "object" && point !== null && "meta" in point && !point.meta.missing);
    return hasLoss || hasLatency;
  }, [latency.measuredSeries.data, loss.measuredSeries.data]);

  const option = useMemo(() => {
    const lossMeasured = {
      ...loss.measuredSeries
    };
    const latencyMeasured = {
      ...latency.measuredSeries,
      color: LATENCY_SERIES_COLOR,
      lineStyle: { ...(latency.measuredSeries.lineStyle as Record<string, unknown>), color: LATENCY_SERIES_COLOR },
      itemStyle: { color: LATENCY_SERIES_COLOR }
    };

    const maxLatency = points.reduce((acc, point) => {
      if (point.avg_latency_ms === null || point.avg_latency_ms === undefined) {
        return acc;
      }
      return Math.max(acc, point.avg_latency_ms);
    }, 0);
    const latencyAxisMax = Math.max(20, Math.ceil(maxLatency / 20) * 20);
    const noProbeLegendSeries = {
      name: NO_PROBE_LEGEND_NAME,
      type: "line",
      smooth: false,
      connectNulls: false,
      showSymbol: false,
      symbol: "none",
      yAxisIndex: 0,
      silent: true,
      tooltip: { show: false },
      lineStyle: { type: "dotted", width: 2, color: palette.textSubtle, opacity: 0.85 },
      itemStyle: { color: palette.textSubtle },
      data: [[buckets[0] ?? rangeStartMs, null]]
    };

    return {
      animation: false,
      backgroundColor: "transparent",
      tooltip: {
        trigger: "axis",
        formatter: (rawParams: unknown) => {
          const params = (Array.isArray(rawParams) ? rawParams : [rawParams]) as Array<{
            axisValue?: number | string;
            data?: unknown;
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
          let noProbeLoss = false;
          let noProbeLatency = false;
          let sentCount: number | null = null;
          let failCount: number | null = null;

          for (const param of params) {
            const data = typeof param.data === "object" && param.data !== null ? (param.data as Partial<ChartPoint>) : null;
            const meta = data?.meta;
            const value = Array.isArray(param.value) ? param.value[1] : null;

            if (meta?.metric === "loss") {
              if (meta.missing) {
                noProbeLoss = true;
              } else if (typeof value === "number") {
                lossValue = value;
                if (typeof meta.sentCount === "number") {
                  sentCount = meta.sentCount;
                }
                if (typeof meta.failCount === "number") {
                  failCount = meta.failCount;
                }
              }
            }

            if (meta?.metric === "latency") {
              if (meta.missing) {
                noProbeLatency = true;
              } else if (typeof value === "number") {
                latencyValue = value;
              }
            }
          }

          const lines: string[] = [header];
          lines.push(`Loss Rate: ${noProbeLoss ? "No probe data" : lossValue === null ? "—" : formatPercent(lossValue)}`);
          lines.push(`Latency: ${noProbeLatency ? "No probe data" : latencyValue === null ? "—" : formatLatency(latencyValue)}`);
          if (sentCount !== null && failCount !== null) {
            lines.push(`Sent/Fail: ${sentCount}/${failCount}`);
          }
          if (noProbeLoss || noProbeLatency) {
            lines.push("Dotted segments indicate no probe activity.");
          }
          return lines.join("<br/>");
        }
      },
      legend: {
        data: ["Loss %", "Latency", NO_PROBE_LEGEND_NAME],
        textStyle: { color: palette.textMuted, fontSize: legendFontSizePx }
      },
      visualMap: {
        show: false,
        type: "piecewise",
        seriesIndex: 0,
        dimension: 1,
        pieces: [
          { lt: 0.5, color: palette.success },
          { gte: 0.5, lt: 99.5, color: palette.warning },
          { gte: 99.5, color: palette.danger }
        ]
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
      series: [lossMeasured, loss.noProbeSeries, latencyMeasured, latency.noProbeSeries, noProbeLegendSeries]
    };
  }, [
    buckets,
    legendFontSizePx,
    latency.measuredSeries,
    latency.noProbeSeries,
    loss.measuredSeries,
    loss.noProbeSeries,
    palette,
    points,
    rangeStartMs,
    rangeEndMs
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
      <div className="chart-summary-grid" id={chartSummaryId}>
        <div className="chart-summary-item">
          <span className="chart-summary-label">Endpoint</span>
          <strong className="chart-summary-value">{endpointLabel}</strong>
        </div>
        <div className="chart-summary-item">
          <span className="chart-summary-label">Range</span>
          <strong className="chart-summary-value">{chartRangeLabel}</strong>
        </div>
        <div className="chart-summary-item">
          <span className="chart-summary-label">Rollup</span>
          <strong className="chart-summary-value">{rollup}</strong>
        </div>
        <div className="chart-summary-item">
          <span className="chart-summary-label">Latest loss</span>
          <strong className="chart-summary-value">{chartTextSummary.latestLossLabel}</strong>
        </div>
        <div className="chart-summary-item">
          <span className="chart-summary-label">Latest latency</span>
          <strong className="chart-summary-value">{chartTextSummary.latestLatencyLabel}</strong>
        </div>
        <div className="chart-summary-item">
          <span className="chart-summary-label">Probe coverage</span>
          <strong className="chart-summary-value">{chartTextSummary.noProbeLabel}</strong>
        </div>
      </div>
      <div className="chart-summary-note">{chartTextSummary.latestIntervalLabel}</div>
      {controlsChanged ? (
        <div className="info-banner chart-snapshot-note" role="status" aria-live="polite">
          Controls changed after this snapshot. Reselect an endpoint to capture a new chart.
        </div>
      ) : null}
      {!hasProbeActivity ? (
        <div className="info-banner chart-no-probe-banner" role="status" aria-live="polite">
          <span className="chart-no-probe-dot" aria-hidden />
          <span>No probe activity was recorded in this captured period.</span>
        </div>
      ) : null}
      <div className="chart-body" role="group" aria-label="Loss and latency chart" aria-describedby={chartSummaryId}>
        <ChartErrorBoundary resetKey={String(snapshotVersion)}>
          {!hasRenderableSeries ? (
            <div className="state-panel chart-empty-series-panel">
              No chart data is available for this captured snapshot.
            </div>
          ) : (
            <div className="chart-canvas-shell" aria-hidden="true">
              <ReactECharts option={option} notMerge lazyUpdate className="chart-canvas" style={{ height: "100%", width: "100%" }} />
            </div>
          )}
        </ChartErrorBoundary>
      </div>
    </div>
  );
}
