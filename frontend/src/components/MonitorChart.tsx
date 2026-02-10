import ReactECharts from "echarts-for-react";
import { useMemo } from "react";
import type { TimeSeriesPoint, TimeSeriesResponse } from "../types/api";

type Props = {
  points: TimeSeriesPoint[];
  endpointLabel: string;
  rollup: TimeSeriesResponse["rollup"];
  rangeStart: Date;
  rangeEnd: Date;
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

const LATENCY_SERIES_COLOR = "#2563EB";

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

function buildBuckets(rangeStart: Date, rangeEnd: Date, stepMs: number): number[] {
  const start = alignToStep(rangeStart.getTime(), stepMs);
  const end = alignToStep(rangeEnd.getTime(), stepMs);
  const buckets: number[] = [];
  for (let current = start; current <= end; current += stepMs) {
    buckets.push(current);
  }
  return buckets;
}

function buildMetricSeries(
  points: TimeSeriesPoint[],
  metric: Metric,
  buckets: number[],
  rollup: TimeSeriesResponse["rollup"],
  noProbeColor: string,
  latencyColor: string
) {
  const grouped = new Map<number, TimeSeriesPoint[]>();
  points.forEach((point) => {
    const existing = grouped.get(point.endpoint_id) || [];
    existing.push(point);
    grouped.set(point.endpoint_id, existing);
  });

  const measured: Array<Record<string, unknown>> = [];
  const noProbe: Array<Record<string, unknown>> = [];

  Array.from(grouped.entries()).forEach(([endpointID, data]) => {
    const pointByBucket = new Map<number, TimeSeriesPoint>();
    data.forEach((point) => {
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

    measured.push({
      name: metric === "loss_rate" ? "Loss %" : "Latency",
      type: "line",
      smooth: true,
      connectNulls: false,
      showSymbol: false,
      yAxisIndex: metric === "loss_rate" ? 0 : 1,
      lineStyle: metric === "loss_rate" ? { width: 3 } : { width: 3, color: latencyColor },
      data: measuredData
    });

    noProbe.push({
      name: metric === "loss_rate" ? "No probe loss" : "No probe latency",
      type: "line",
      smooth: true,
      connectNulls: false,
      showSymbol: false,
      yAxisIndex: metric === "loss_rate" ? 0 : 1,
      lineStyle: { type: "dotted", width: 2, color: noProbeColor, opacity: 0.85 },
      itemStyle: { color: noProbeColor },
      data: noProbeData
    });
  });

  return { measured, noProbe };
}

function readToken(name: string, fallback: string): string {
  if (typeof window === "undefined") {
    return fallback;
  }
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function resolveLossColor(lossValue: number | null, palette: { success: string; warning: string; danger: string; textSubtle: string }): string {
  if (lossValue === null) {
    return palette.textSubtle;
  }
  if (lossValue <= 0) {
    return palette.success;
  }
  if (lossValue <= 1) {
    return palette.warning;
  }
  if (lossValue <= 10) {
    return "#f97316";
  }
  return palette.danger;
}

function getLatestLossValue(points: TimeSeriesPoint[]): number | null {
  let latestTs = Number.NEGATIVE_INFINITY;
  let latestLoss: number | null = null;
  for (const point of points) {
    if (point.sent_count <= 0 || point.loss_rate === null || point.loss_rate === undefined) {
      continue;
    }
    const ts = new Date(point.bucket).getTime();
    if (Number.isNaN(ts)) {
      continue;
    }
    if (ts >= latestTs) {
      latestTs = ts;
      latestLoss = point.loss_rate;
    }
  }
  return latestLoss;
}

export function MonitorChart({ points, endpointLabel, rollup, rangeStart, rangeEnd }: Props) {
  const palette = {
    textMuted: readToken("--color-text-muted", "#b4c3db"),
    textSubtle: readToken("--color-text-subtle", "#94a7c4"),
    border: readToken("--color-border", "#21324d"),
    success: readToken("--color-success", "#10b981"),
    warning: readToken("--color-warning", "#f59e0b"),
    danger: readToken("--color-danger", "#ef4444")
  };

  const option = useMemo(() => {
    const buckets = buildBuckets(rangeStart, rangeEnd, toStepMs(rollup));
    const loss = buildMetricSeries(points, "loss_rate", buckets, rollup, palette.textSubtle, palette.success);
    const latency = buildMetricSeries(points, "avg_latency_ms", buckets, rollup, palette.textSubtle, LATENCY_SERIES_COLOR);
    const latestLossValue = getLatestLossValue(points);
    const lossLegendColor = resolveLossColor(latestLossValue, palette);
    const lossMeasured = loss.measured.map((seriesDef) => ({
      ...seriesDef,
      color: lossLegendColor,
      lineStyle: { ...(seriesDef.lineStyle as Record<string, unknown>), color: lossLegendColor },
      itemStyle: { color: lossLegendColor }
    }));
    const latencyMeasured = latency.measured.map((seriesDef) => ({
      ...seriesDef,
      color: LATENCY_SERIES_COLOR,
      lineStyle: { ...(seriesDef.lineStyle as Record<string, unknown>), color: LATENCY_SERIES_COLOR },
      itemStyle: { color: LATENCY_SERIES_COLOR }
    }));

    const maxLatency = points.reduce((acc, point) => {
      if (point.avg_latency_ms === null || point.avg_latency_ms === undefined) {
        return acc;
      }
      return Math.max(acc, point.avg_latency_ms);
    }, 0);
    const latencyAxisMax = Math.max(20, Math.ceil(maxLatency / 20) * 20);

    const series = [...lossMeasured, ...loss.noProbe, ...latencyMeasured, ...latency.noProbe];
    const measuredLossCount = lossMeasured.length;
    const lossLegendNames = Array.from(
      new Set(loss.measured.map((item) => ((item as { name?: string }).name ?? "Loss %")))
    );
    const latencyLegendNames = Array.from(
      new Set(latency.measured.map((item) => ((item as { name?: string }).name ?? "Latency")))
    );
    const lossSeriesIndices = Array.from({ length: measuredLossCount }, (_, index) => index);

    return {
      backgroundColor: "transparent",
      tooltip: {
        trigger: "axis",
        formatter: (rawParams: unknown) => {
          const params = (Array.isArray(rawParams) ? rawParams : [rawParams]) as Array<any>;
          if (params.length === 0) {
            return "";
          }

          const axisValue = params[0]?.axisValue;
          const timestamp = typeof axisValue === "number" ? axisValue : new Date(axisValue).getTime();
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
            const data = typeof param?.data === "object" && param?.data !== null ? param.data : null;
            const meta = data?.meta;
            const value = Array.isArray(param?.value) ? param.value[1] : null;

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
        data: [...lossLegendNames, ...latencyLegendNames],
        textStyle: { color: palette.textMuted, fontSize: 11 }
      },
      visualMap: [
        {
          show: false,
          type: "piecewise",
          dimension: 1,
          seriesIndex: lossSeriesIndices,
          pieces: [
            { lte: 0, color: palette.success },
            { gt: 0, lte: 1, color: palette.warning },
            { gt: 1, lte: 10, color: "#f97316" },
            { gt: 10, color: palette.danger }
          ]
        }
      ],
      grid: {
        left: 64,
        right: 56,
        top: 36,
        bottom: 38
      },
      xAxis: {
        type: "time",
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
      series
    };
  }, [palette.border, palette.danger, palette.success, palette.textMuted, palette.textSubtle, palette.warning, points, rangeEnd, rangeStart, rollup]);

  return (
    <div className="panel chart-panel">
      <div className="chart-header">
        <div>
          <div className="chart-title">Loss & Latency Timeline</div>
          <div className="chart-subtitle">Selected endpoint: {endpointLabel}</div>
        </div>
      </div>
      <ReactECharts option={option} className="chart-canvas" />
    </div>
  );
}
