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
import { Activity, BarChart3, ShoppingBag, Loader2 } from "lucide-react";

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

// Theme-aware text colour for chart axes/legends/tooltips. CSS variables
// don't resolve when recharts sets them as SVG `fill` attributes, so we
// read the *resolved* --foreground colour off a hidden probe element and
// pass the concrete rgb() value. This is white-ish on the dark theme and
// dark on the light theme, and re-reads whenever the theme changes.
function useAxisColor(): string {
  const [color, setColor] = useState("#e5e7eb");
  useEffect(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--foreground)";
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.style.pointerEvents = "none";
    document.body.appendChild(probe);
    const read = () => {
      const c = getComputedStyle(probe).color;
      if (c) setColor(c);
    };
    // eslint-disable-next-line react-hooks/set-state-in-effect
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    return () => {
      obs.disconnect();
      probe.remove();
    };
  }, []);
  return color;
}

const COLORS = {
  conversaciones: "#3b82f6", // azul
  ventas: "#22c55e", // verde
  clientesNuevos: "#7c3aed", // violeta
};

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

// ---------------------------------------------------------------------------
// Actividad diaria (30 días): conversaciones + ventas + clientes nuevos.
// Ventas se cuentan por fecha de la venta (sold_at), no por cuándo se creó
// el deal — así la compra aparece el día real en que el cliente compró.
//
// "Clientes nuevos" (línea morada) = contactos cuya PRIMERA venta cayó ese
// día. Se calcula con la fecha fija de la primera venta (min sold_at por
// contacto), NUNCA con la etiqueta "Cliente nuevo" — la etiqueta rota a
// "Cliente viejo" a los 30 días y borraría el histórico; la fecha de la
// primera venta es inmutable, así que la gráfica siempre cuadra.
// ---------------------------------------------------------------------------
export function ActivityChart() {
  const axis = useAxisColor();
  const [data, setData] = useState<
    { day: string; conversaciones: number; ventas: number; clientesNuevos: number }[]
    | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const db = createClient();
      const since = new Date();
      since.setDate(since.getDate() - (DAYS - 1));
      since.setHours(0, 0, 0, 0);
      const sinceIso = since.toISOString();

      const [{ data: msgs }, { data: sales }, { data: allSold }] =
        await Promise.all([
          db
            .from("messages")
            .select("conversation_id, created_at")
            .eq("sender_type", "customer")
            .gte("created_at", sinceIso)
            .limit(20000),
          db
            .from("deals")
            .select("sold_at")
            .not("sold_at", "is", null)
            .gte("sold_at", sinceIso)
            .limit(20000),
          // Full history of sold deals: needed to know each contact's
          // FIRST sale (a buyer with an older sale is not "nuevo").
          db
            .from("deals")
            .select("contact_id, sold_at")
            .not("sold_at", "is", null)
            .not("contact_id", "is", null)
            .limit(20000),
        ]);
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
      for (const s of (sales ?? []) as { sold_at: string }[]) {
        const k = ymd(new Date(s.sold_at));
        salesByDay.set(k, (salesByDay.get(k) ?? 0) + 1);
      }

      // First sale per contact → count of brand-new customers per day.
      const firstSale = new Map<string, number>();
      for (const d of (allSold ?? []) as {
        contact_id: string;
        sold_at: string;
      }[]) {
        const t = new Date(d.sold_at).getTime();
        const prev = firstSale.get(d.contact_id);
        if (prev === undefined || t < prev) firstSale.set(d.contact_id, t);
      }
      const newByDay = new Map<string, number>();
      for (const t of firstSale.values()) {
        const k = ymd(new Date(t));
        newByDay.set(k, (newByDay.get(k) ?? 0) + 1);
      }

      setData(
        lastNDays(DAYS).map((k) => ({
          day: k,
          conversaciones: convByDay.get(k)?.size ?? 0,
          ventas: salesByDay.get(k) ?? 0,
          clientesNuevos: newByDay.get(k) ?? 0,
        })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card
      title="Conversaciones, ventas y clientes nuevos"
      subtitle="Actividad por día (últimos 30 días)"
      icon={Activity}
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
              tick={{ fill: axis, fontSize: 11 }}
              interval="preserveStartEnd"
              minTickGap={24}
            />
            <YAxis allowDecimals={false} tick={{ fill: axis, fontSize: 11 }} width={28} />
            <Tooltip
              labelFormatter={(v) => shortLabel(String(v))}
              contentStyle={{
                background: "var(--popover)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
              }}
              labelStyle={{ color: axis }}
              itemStyle={{ color: axis }}
            />
            <Legend wrapperStyle={{ fontSize: 12, color: axis }} />
            <Line
              type="monotone"
              dataKey="conversaciones"
              name="Conversaciones"
              stroke={COLORS.conversaciones}
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="ventas"
              name="Ventas"
              stroke={COLORS.ventas}
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="clientesNuevos"
              name="Clientes nuevos"
              stroke={COLORS.clientesNuevos}
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
// Valor del pipeline por columna (barras) — compacta.
// ---------------------------------------------------------------------------
export function PipelineValueBars({ currency }: { currency: string }) {
  const axis = useAxisColor();
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
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="name"
              tick={{ fill: axis, fontSize: 10 }}
              interval={0}
              angle={-20}
              textAnchor="end"
              height={54}
            />
            <YAxis
              tick={{ fill: axis, fontSize: 10 }}
              width={58}
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
              labelStyle={{ color: axis }}
              itemStyle={{ color: axis }}
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
// Compras recientes.
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
