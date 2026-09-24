/** Small formatting helpers shared by the report renderers. No table-drawing dependency; this is simple enough to hand-roll. */

export function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

export function padLeft(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

export function formatTokensPerSecond(tokensPerSecond: number): string {
  return `${tokensPerSecond.toFixed(1)} tok/s`;
}

export function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}

/** Renders rows of equal-length string arrays as a simple left-aligned, space-padded table with a header separator. */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const renderRow = (cells: string[]) => cells.map((c, i) => padRight(c, widths[i])).join("  ");
  const separator = widths.map((w) => "-".repeat(w)).join("  ");
  return [renderRow(headers), separator, ...rows.map(renderRow)].join("\n");
}
