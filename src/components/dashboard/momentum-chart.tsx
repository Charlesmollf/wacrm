"use client";

import { useEffect, useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { createClient } from "@/lib/supabase/client";

// Momentum / run-rate chart. Three daily-rate lines over the current
// month so the user can see whether the recent pace beats the longer
// baseline (green/orange above blue = closing the month above the
// 30-day average). Hovering shows the projected month-end total if the
// current run rate holds.

const COLORS = {
  daily: "#f97316", // orange — daily sales
  avg7: "#22c55e", // green — 7-day average
  avg30: "#3b82f6", // blue — 30-day average
};

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface Point {
  day: number;
  daily: number;
  avg7: number;
  avg30: number;
}

function qFmt(v: number): string {
  return `Q${Math.round(v).toLocaleString()}`;
}

export function MomentumChart() {
  const [salesByDay, setSalesByDay] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const since = new Date();
      since.setDate(since.getDate() - 60);
      const { data } = await supabase
        .from("deals")
        .select("value, sold_at")
        .not("sold_at", "is", null)
        .gte("sold_at", since.toISOString());
      if (cancelled) return;
      const map: Record<string, number> = {};
      for (const row of (data ?? []) as { value: number | null; sold_at: string | null }[]) {
        if (!row.sold_at) continue;
        const key = row.sold_at.slice(0, 10);
        map[key] = (map[key] ?? 0) + (Number(row.value) || 0);
      }
      setSalesByDay(map);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const { data, mtd, remaining, monthTotalConfirmed } = useMemo(() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const todayDay = now.getDate();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const avgWindow = (end: Date, days: number): number => {
      let sum = 0;
      for (let i = 0; i < days; i++) {
        const d = new Date(end);
        d.setDate(end.getDate() - i);
        sum += salesByDay[ymd(d)] ?? 0;
      }
      return sum / days;
    };

    const points: Point[] = [];
    let monthToDate = 0;
    for (let day = 1; day <= todayDay; day++) {
      const date = new Date(year, month, day);
      const daily = salesByDay[ymd(date)] ?? 0;
      monthToDate += daily;
      points.push({
        day,
        daily,
        avg7: avgWindow(date, 7),
        avg30: avgWindow(date, 30),
      });
    }
    return {
      data: points,
      mtd: monthToDate,
      remaining: daysInMonth - todayDay,
      monthTotalConfirmed: monthToDate,
    };
  }, [salesByDay]);

  // Custom tooltip: for each rate line, project the month-end close as
  // "sold so far this month + rate x days remaining".
  const renderTooltip = ({
    active,
    payload,
    label,
  }: {
    active?: boolean;
    payload?: { dataKey: string; value: number; color: string }[];
    label?: number;
  }) => {
    if (!active || !payload || payload.length === 0) return null;
    const labels: Record<string, string> = {
      daily: "Diario",
      avg7: "Prom. 7 días",
      avg30: "Prom. 30 días",
    };
    return (
      <div className="rounded-lg border border-border bg-popover p-3 text-xs shadow-lg">
        <p className="mb-1 font-semibold text-popover-foreground">Día {label}</p>
        {payload.map((p) => {
          const projection = mtd + p.value * remaining;
          return (
            <div key={p.dataKey} className="mb-1">
              <span style={{ color: p.color }} className="font-medium">
                {labels[p.dataKey] ?? p.dataKey}: {qFmt(p.value)}/día
              </span>
              <div className="text-muted-foreground">
                Cierre proyectado: <span className="font-semibold text-foreground">{qFmt(projection)}</span>
              </div>
            </div>
          );
        })}
        <p className="mt-1 border-t border-border pt-1 text-[10px] text-muted-foreground">
          Vendido este mes: {qFmt(mtd)} · faltan {remaining} días
        </p>
      </div>
    );
  };

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between p-5 pb-0">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Momentum de ventas</h3>
          <p className="text-xs text-muted-foreground">
            Ritmo diario vs. promedios de 7 y 30 días (Quetzales). Pon el cursor
            para ver el cierre de mes proyectado.
          </p>
        </div>
        <div className="hidden items-center gap-3 text-[11px] sm:flex">
          <span className="flex items-center gap-1"><span className="size-2 rounded-full" style={{ background: COLORS.daily }} />Diario</span>
          <span className="flex items-center gap-1"><span className="size-2 rounded-full" style={{ background: COLORS.avg7 }} />7 días</span>
          <span className="flex items-center gap-1"><span className="size-2 rounded-full" style={{ background: COLORS.avg30 }} />30 días</span>
        </div>
      </div>
      <div className="p-5">
        {loading ? (
          <div className="h-64 w-full animate-pulse rounded-lg bg-muted/50" />
        ) : monthTotalConfirmed === 0 ? (
          <div className="flex h-64 w-full flex-col items-center justify-center rounded-lg bg-muted/20 text-center">
            <p className="text-sm text-muted-foreground">Aún no hay ventas confirmadas este mes.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              La gráfica se llena cuando el bot registra el total de una venta confirmada.
            </p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.3} />
              <XAxis
                dataKey="day"
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={false}
                width={48}
                tickFormatter={(v) => qFmt(v)}
              />
              <Tooltip content={renderTooltip} />
              <Line type="monotone" dataKey="avg30" stroke={COLORS.avg30} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="avg7" stroke={COLORS.avg7} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="daily" stroke={COLORS.daily} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
