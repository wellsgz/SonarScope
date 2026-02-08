import ReactECharts from "echarts-for-react";
import { useMemo } from "react";
import type { TimeSeriesPoint } from "../types/api";

type Props = {
  points: TimeSeriesPoint[];
  endpointLabel: string;
};

function buildLineSeries(points: TimeSeriesPoint[], metric: "loss_rate" | "avg_latency_ms") {
  const grouped = new Map<number, TimeSeriesPoint[]>();
  points.forEach((point) => {
    const existing = grouped.get(point.endpoint_id) || [];
    existing.push(point);
    grouped.set(point.endpoint_id, existing);
  });

  return Array.from(grouped.entries()).map(([endpointID, data]) => {
    const sorted = data.sort((a, b) => new Date(a.bucket).getTime() - new Date(b.bucket).getTime());
    return {
      name: metric === "loss_rate" ? `Loss % · ${endpointID}` : `Latency · ${endpointID}`,
      type: "line",
      smooth: true,
      showSymbol: false,
      yAxisIndex: metric === "loss_rate" ? 0 : 1,
      data: sorted.map((point) => [point.bucket, metric === "loss_rate" ? point.loss_rate : point.avg_latency_ms])
    };
  });
}

function readToken(name: string, fallback: string): string {
  if (typeof window === "undefined") {
    return fallback;
  }
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function MonitorChart({ points, endpointLabel }: Props) {
  const palette = {
    textMuted: readToken("--color-text-muted", "#b4c3db"),
    textSubtle: readToken("--color-text-subtle", "#94a7c4"),
    border: readToken("--color-border", "#21324d"),
    accent: readToken("--color-accent", "#818cf8"),
    success: readToken("--color-success", "#10b981")
  };

  const option = useMemo(() => {
    const lossSeries = buildLineSeries(points, "loss_rate");
    const latencySeries = buildLineSeries(points, "avg_latency_ms");

    return {
      backgroundColor: "transparent",
      tooltip: {
        trigger: "axis"
      },
      legend: {
        textStyle: { color: palette.textMuted, fontSize: 11 }
      },
      grid: {
        left: 48,
        right: 40,
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
          axisLabel: { color: palette.textSubtle },
          nameTextStyle: { color: palette.textMuted },
          splitLine: { lineStyle: { color: palette.border } }
        },
        {
          type: "value",
          name: "Latency (ms)",
          axisLabel: { color: palette.textSubtle },
          nameTextStyle: { color: palette.textMuted },
          splitLine: { show: false }
        }
      ],
      series: [
        ...lossSeries.map((series) => ({ ...series, lineStyle: { color: palette.accent } })),
        ...latencySeries.map((series) => ({ ...series, lineStyle: { color: palette.success } }))
      ]
    };
  }, [palette.accent, palette.border, palette.success, palette.textMuted, palette.textSubtle, points]);

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
