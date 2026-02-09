export type QuickRange = "5m" | "30m" | "1h" | "12h" | "24h" | "custom";

export function rangeToDatesAt(range: QuickRange, anchor: Date): { start: Date; end: Date } {
  const end = new Date(anchor.getTime());
  const start = new Date(end.getTime());

  switch (range) {
    case "5m":
      start.setMinutes(end.getMinutes() - 5);
      break;
    case "30m":
      start.setMinutes(end.getMinutes() - 30);
      break;
    case "1h":
      start.setHours(end.getHours() - 1);
      break;
    case "12h":
      start.setHours(end.getHours() - 12);
      break;
    case "24h":
      start.setHours(end.getHours() - 24);
      break;
    default:
      break;
  }

  return { start, end };
}

export function rangeToDates(range: QuickRange): { start: Date; end: Date } {
  return rangeToDatesAt(range, new Date());
}

export function toApiTime(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}-${pad(
    date.getUTCHours()
  )}-${pad(date.getUTCMinutes())}-${pad(date.getUTCSeconds())}`;
}
