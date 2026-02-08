import ReactECharts from "echarts-for-react";
import { useMemo } from "react";
import type { TimeSeriesPoint } from "../types/api";

type Props = {
  points: TimeSeriesPoint[];
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

export function MonitorChart({ points }: Props) {
  const option = useMemo(() => {
    const lossSeries = buildLineSeries(points, "loss_rate");
    const latencySeries = buildLineSeries(points, "avg_latency_ms");

    return {
      backgroundColor: "transparent",
      tooltip: {
        trigger: "axis"
      },
      legend: {
        textStyle: { color: "#dbe8f7" }
      },
      grid: {
        left: 48,
        right: 40,
        top: 36,
        bottom: 38
      },
      xAxis: {
        type: "time",
        axisLabel: { color: "#b8d4ee" },
        axisLine: { lineStyle: { color: "#5d8fc5" } }
      },
      yAxis: [
        {
          type: "value",
          name: "Loss Rate (%)",
          axisLabel: { color: "#b8d4ee" },
          splitLine: { lineStyle: { color: "rgba(184, 212, 238, 0.15)" } }
        },
        {
          type: "value",
          name: "Latency (ms)",
          axisLabel: { color: "#b8d4ee" },
          splitLine: { show: false }
        }
      ],
      series: [...lossSeries, ...latencySeries]
    };
  }, [points]);

  return (
    <div className="panel chart-panel">
      <ReactECharts option={option} style={{ height: "100%", minHeight: 280 }} />
    </div>
  );
}
