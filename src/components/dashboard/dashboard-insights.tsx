"use client";

import { useEffect, useState, type ElementType } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/currency";
import {
  BarChart,
  Bar,
  Cell,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import {
  MessageSquare,
  UserPlus,
  BarChart3,
  ShoppingBag,
  Loader2,
} from "lucide-react";

const DAYS = 30;

// Local YYYY-MM-DD (the dashboard runs in the store's own timezone).
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function lastNDays(n: number): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    out.push(ymd(d));
  }
  return out;
}

function shortLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function Card({
  title,
  subtitle,
  icon: Icon,
  children,
}: {
  title: string;
  subtitle?: string;
  icon: ElementType;
  children: React.ReactNode;
}) {
  return (
    <section className="flex h-full flex-col rounded-xl border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-5 py-4">
        <Icon className="h-4 w-4 text-primary" />
        <div>
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {subtitle ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
      </header>
      <div className="flex-1 p-4">{children}</div>
    </section>
  );
}

function Loading() {
  return (
    <div className="flex h-[240px] items-center justify-center text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  );
}

const AXIS = "var(--muted-foreground)";

// ---------------------------------------------------------------------------
// 1) Conversaciones vs Ventas (30 días): personas que escriben por día
//    contrastado con ventas por día (pedidos confirmados, por fecha de
//    generación del deal — no de aprobación).
// ---------------------------------------------------------------------------
export function ConversationsVsSalesChart() {
  const [data, setData] = useState<
    { day: string; conversaciones: number; ventas: number }[] | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const db = createClient();
      const since = new Date();
      since.setDate(since.getDate() - (DAYS - 1));
      since.setHours(0, 0, 0, 0);
      const sinceIso = since.toISOString();

      const [{ data: msgs }, { data: stages }] = await Promise.all([
        db
          .from("messages")
          .select("conversation_id, created_at")
          .eq("sender_type", "customer")
          .gte("created_at", sinceIso)
          .limit(20000),
        db.from("pipeline_stages").select("id").ilike("name", "Pedido Confirmado"),
      ]);

      const stageIds = ((stages ?? []) as { id: string }[]).map((s) => s.id);
      let deals: { created_at: string }[] = [];
      if (stageIds.length > 0) {
        const { data: dd } = await db
          .from("deals")
          .select("created_at, stage_id")
          .in("stage_id", stageIds)
          .gte("created_at", sinceIso)
          .limit(20000);
        deals = (dd ?? []) as { created_at: string }[];
      }
      if (cancelled) return;

      const convByDay = new Map<string, Set<string>>();
      for (const m of (msgs ?? []) as {
        conversation_id: string | null;
        created_at: string;
      }[]) {
        const k = ymd(new Date(m.created_at));
        if (!convByDay.has(k)) convByDay.set(k, new Set());
        if (m.conversation_id) convByDay.get(k)!.add(m.conversation_id);
      }
      const salesByDay = new Map<string, number>();
      for (const d of deals) {
        const k = ymd(new Date(d.created_at));
        salesByDay.set(k, (salesByDay.get(k) ?? 0) + 1);
      }

      setData(
        lastNDays(DAYS).map((k) => ({
          day: k,
          conversaciones: convByDay.get(k)?.size ?? 0,
          ventas: salesByDay.get(k) ?? 0,
        })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card
      title="Conversaciones vs Ventas"
      subtitle="Personas que escriben vs ventas por día (últimos 30 días)"
      icon={MessageSquare}
    >
      {data === null ? (
        <Loading />
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              dataKey="day"
              tickFormatter={(v) => shortLabel(String(v))}
              tick={{ fill: AXIS, fontSize: 11 }}
              interval="preserveStartEnd"
              minTickGap={24}
            />
            <YAxis allowDecimals={false} tick={{ fill: AXIS, fontSize: 11 }} width={28} />
            <Tooltip
              labelFormatter={(v) => shortLabel(String(v))}
              contentStyle={{
                background: "var(--popover)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line
              type="monotone"
              dataKey="conversaciones"
              name="Conversaciones"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="ventas"
              name="Ventas"
              stroke="#22c55e"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 2) Nuevos contactos por día (30 días)
// ---------------------------------------------------------------------------
export function NewContactsChart() {
  const [data, setData] = useState<{ day: string; nuevos: number }[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const db = createClient();
      const since = new Date();
      since.setDate(since.getDate() - (DAYS - 1));
      since.setHours(0, 0, 0, 0);
      const { data: contacts } = await db
        .from("contacts")
        .select("created_at")
        .gte("created_at", since.toISOString())
        .limit(20000);
      if (cancelled) return;
      const byDay = new Map<string, number>();
      for (const c of (contacts ?? []) as { created_at: string }[]) {
        const k = ymd(new Date(c.created_at));
        byDay.set(k, (byDay.get(k) ?? 0) + 1);
      }
      setData(lastNDays(DAYS).map((k) => ({ day: k, nuevos: byDay.get(k) ?? 0 })));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card
      title="Nuevos contactos"
      subtitle="Contactos nuevos por día (últimos 30 días)"
      icon={UserPlus}
    >
      {data === null ? (
        <Loading />
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              dataKey="day"
              tickFormatter={(v) => shortLabel(String(v))}
              tick={{ fill: AXIS, fontSize: 11 }}
              interval="preserveStartEnd"
              minTickGap={24}
            />
            <YAxis allowDecimals={false} tick={{ fill: AXIS, fontSize: 11 }} width={28} />
            <Tooltip
              labelFormatter={(v) => shortLabel(String(v))}
              contentStyle={{
                background: "var(--popover)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
              }}
            />
            <Line
              type="monotone"
              dataKey="nuevos"
              name="Nuevos contactos"
              stroke="#7c3aed"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 3) Valor del pipeline por columna (barras)
// ---------------------------------------------------------------------------
export function PipelineValueBars({ currency }: { currency: string }) {
  const [data, setData] = useState<
    { name: string; value: number; color: string }[] | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const db = createClient();
      const [{ data: stages }, { data: deals }] = await Promise.all([
        db
          .from("pipeline_stages")
          .select("id, name, color, position")
          .order("position"),
        db.from("deals").select("stage_id, value").limit(20000),
      ]);
      if (cancelled) return;
      const sum = new Map<string, number>();
      for (const d of (deals ?? []) as {
        stage_id: string;
        value: number | null;
      }[]) {
        sum.set(d.stage_id, (sum.get(d.stage_id) ?? 0) + (Number(d.value) || 0));
      }
      setData(
        ((stages ?? []) as {
          id: string;
          name: string;
          color: string | null;
        }[]).map((s) => ({
          name: s.name,
          value: sum.get(s.id) ?? 0,
          color: s.color || "#3b82f6",
        })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const fmt = (v: number) => formatCurrency(v, currency);

  return (
    <Card
      title="Valor del pipeline por columna"
      subtitle="Suma del valor de los deals en cada etapa"
      icon={BarChart3}
    >
      {data === null ? (
        <Loading />
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={data} margin={{ top: 8, right: 12, left: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="name"
              tick={{ fill: AXIS, fontSize: 11 }}
              interval={0}
              angle={-15}
              textAnchor="end"
              height={50}
            />
            <YAxis
              tick={{ fill: AXIS, fontSize: 11 }}
              width={64}
              tickFormatter={(v) => fmt(Number(v))}
            />
            <Tooltip
              formatter={(v) => fmt(Number(v))}
              contentStyle={{
                background: "var(--popover)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
              }}
            />
            <Bar dataKey="value" name="Valor" radius={[4, 4, 0, 0]}>
              {data.map((d, i) => (
                <Cell key={i} fill={d.color} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 4) Compras recientes (reemplaza el feed de actividad)
// ---------------------------------------------------------------------------
interface PurchaseRow {
  id: string;
  name: string;
  value: number;
  at: string | null;
}

export function RecentPurchases({ currency }: { currency: string }) {
  const [rows, setRows] = useState<PurchaseRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const db = createClient();
      const { data } = await db
        .from("deals")
        .select(
          "id, value, sold_at, updated_at, payment_status, contact:contacts(name, phone)",
        )
        .eq("payment_status", "Pagado")
        .order("updated_at", { ascending: false })
        .limit(20);
      if (cancelled) return;
      type Row = {
        id: string;
        value: number | null;
        sold_at: string | null;
        updated_at: string | null;
        contact:
          | { name: string | null; phone: string | null }
          | { name: string | null; phone: string | null }[]
          | null;
      };
      const mapped: PurchaseRow[] = ((data ?? []) as Row[]).map((d) => {
        const c = Array.isArray(d.contact) ? d.contact[0] : d.contact;
        return {
          id: d.id,
          name: c?.name || c?.phone || "Cliente",
          value: Number(d.value) || 0,
          at: d.sold_at ?? d.updated_at,
        };
      });
      setRows(mapped);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card
      title="Compras recientes"
      subtitle="Últimas ventas confirmadas"
      icon={ShoppingBag}
    >
      {rows === null ? (
        <div className="flex items-center justify-center py-10 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          Aún no hay compras confirmadas.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="flex items-center gap-2 min-w-0">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  {r.name.charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{r.name}</p>
                  {r.at ? (
                    <p className="text-xs text-muted-foreground">
                      {new Date(r.at).toLocaleDateString(undefined, {
                        day: "numeric",
                        month: "short",
                      })}
                    </p>
                  ) : null}
                </div>
              </div>
              <span className="shrink-0 text-sm font-semibold text-primary">
                {formatCurrency(r.value, currency)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
