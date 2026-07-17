"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { Deal } from "@/types";
import {
  BadgeCheck,
  Check,
  Copy,
  Loader2,
  MessageSquare,
  Package,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

// "Confirmar pagos" — a manual payment-confirmation queue.
//
// The bot never marks a payment as "Pagado". When a customer sends a
// receipt/screenshot or clearly says they paid, the bot sets the deal's
// payment_status to "Por confirmar", which lands the deal here. A human
// reviews each one, verifies against the bank/receipt, and clicks
// "Marcar como Pagado". On confirmation we generate a short order
// summary (from the saved deal fields) ready to paste into the roastery
// WhatsApp group.

const PENDING_STATUS = "Por confirmar";

/** Latest entry of the running combo_history string (newest line). */
function latestCombo(history?: string | null): string | null {
  if (!history) return null;
  const lines = history
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  return lines[lines.length - 1].replace(/^\[[^\]]*\]\s*/, "");
}

/** Build the order summary that gets pasted into the roastery group. */
function buildOrderSummary(deal: Deal): string {
  const name = deal.contact?.name?.trim() || "Cliente";
  const phone = deal.contact?.phone?.trim() || "";
  const producto = latestCombo(deal.combo_history) || deal.title || "—";
  const molienda = deal.grind || "—";
  const total =
    deal.value != null && Number(deal.value) > 0
      ? `Q${Number(deal.value).toLocaleString()}`
      : "—";
  const pago = deal.payment_method || "—";
  const direccion = deal.address?.trim() || "—";
  const nit = deal.nit?.trim() || "—";

  return [
    "🔥 NUEVO PEDIDO CONFIRMADO",
    `👤 Cliente: ${name}${phone ? ` (${phone})` : ""}`,
    `☕ Producto: ${producto}`,
    `⚙️ Molienda: ${molienda}`,
    `💵 Total: ${total} — PAGADO ✅`,
    `💳 Pago: ${pago}`,
    `📍 Dirección: ${direccion}`,
    `🧾 NIT: ${nit}`,
  ].join("\n");
}

interface Row extends Deal {
  convId?: string | null;
}

export default function PaymentsPage() {
  const router = useRouter();
  const { accountId } = useAuth();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<Record<string, string>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    const supabase = createClient();
    const { data, error: fetchErr } = await supabase
      .from("deals")
      .select("*, contact:contacts(*)")
      .eq("payment_status", PENDING_STATUS)
      .order("updated_at", { ascending: false });
    if (fetchErr) {
      setError(fetchErr.message);
      return;
    }
    const deals = (data ?? []) as Deal[];

    const { data: convs } = await supabase
      .from("conversations")
      .select("id, contact_id, last_message_at")
      .order("last_message_at", { ascending: false })
      .limit(5000);
    const byContact = new Map<string, string>();
    for (const c of (convs ?? []) as Array<{
      id: string;
      contact_id: string | null;
    }>) {
      if (c.contact_id && !byContact.has(c.contact_id))
        byContact.set(c.contact_id, c.id);
    }
    setRows(
      deals.map((d) => ({
        ...d,
        convId: d.contact_id ? byContact.get(d.contact_id) ?? null : null,
      })),
    );
  }, [accountId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const markPaid = useCallback(async (deal: Row) => {
    setConfirmingId(deal.id);
    // Route through the server so it can (a) mark the deal paid and (b) fire
    // the Click-to-WhatsApp Purchase signal to Meta with the secret token —
    // which can't happen from the browser.
    let ok = false;
    let errMsg = "";
    try {
      const res = await fetch("/api/payments/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deal_id: deal.id }),
      });
      const json = await res.json().catch(() => null);
      ok = res.ok && json?.ok === true;
      if (!ok) errMsg = json?.error ?? `Error ${res.status}`;
    } catch (e) {
      errMsg = e instanceof Error ? e.message : "Error de red";
    }
    setConfirmingId(null);
    if (!ok) {
      toast.error("No se pudo confirmar el pago: " + errMsg);
      return;
    }
    const summary = buildOrderSummary(deal);
    setConfirmed((prev) => ({ ...prev, [deal.id]: summary }));
    toast.success("Pago confirmado. Resumen del pedido listo para copiar.");
  }, []);

  const copySummary = useCallback(async (dealId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(dealId);
      toast.success("Resumen copiado. Pégalo en el grupo de la tostaduría.");
      setTimeout(() => setCopiedId((c) => (c === dealId ? null : c)), 2000);
    } catch {
      toast.error("No se pudo copiar. Copia el texto manualmente.");
    }
  }, []);

  const pendingCount = useMemo(
    () => (rows ? rows.filter((r) => !confirmed[r.id]).length : 0),
    [rows, confirmed],
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-foreground">
          <BadgeCheck className="h-6 w-6 text-primary" />
          Confirmar pagos
        </h1>
        <p className="text-sm text-muted-foreground">
          Clientes que enviaron comprobante o dijeron que ya pagaron. Revisa
          cada uno, verifica el pago de verdad y márcalo como Pagado. Al
          confirmar, se genera el resumen del pedido para enviar a la
          tostadur&iacute;a.
        </p>
      </header>

      {error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {rows === null ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border py-16 text-center text-muted-foreground">
          <Package className="h-8 w-8 opacity-50" />
          <p className="text-sm">No hay pagos pendientes de confirmar.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((deal) => {
            const summary = confirmed[deal.id];
            const producto = latestCombo(deal.combo_history) || deal.title;
            return (
              <li
                key={deal.id}
                className="rounded-xl border border-border bg-card p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">
                      {deal.contact?.name || "Cliente"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {deal.contact?.phone}
                    </p>
                  </div>
                  {deal.convId ? (
                    <button
                      type="button"
                      onClick={() => router.push(`/inbox?c=${deal.convId}`)}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <MessageSquare className="h-3.5 w-3.5" />
                      Ver chat
                    </button>
                  ) : null}
                </div>

                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-3">
                  <Field label="Producto" value={producto} />
                  <Field label="Molienda" value={deal.grind} />
                  <Field
                    label="Total"
                    value={
                      deal.value != null && Number(deal.value) > 0
                        ? `Q${Number(deal.value).toLocaleString()}`
                        : null
                    }
                  />
                  <Field label="Forma de pago" value={deal.payment_method} />
                  <Field label="NIT" value={deal.nit} />
                  <Field label="Dirección" value={deal.address} />
                </div>

                {summary ? (
                  <div className="mt-4 space-y-2">
                    <pre className="whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 text-xs text-foreground">
                      {summary}
                    </pre>
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      onClick={() => copySummary(deal.id, summary)}
                    >
                      {copiedId === deal.id ? (
                        <>
                          <Check className="h-4 w-4" /> Copiado
                        </>
                      ) : (
                        <>
                          <Copy className="h-4 w-4" /> Copiar resumen para el
                          grupo
                        </>
                      )}
                    </Button>
                  </div>
                ) : (
                  <div className="mt-4">
                    <Button
                      type="button"
                      className="w-full"
                      disabled={confirmingId === deal.id}
                      onClick={() => markPaid(deal)}
                    >
                      {confirmingId === deal.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <BadgeCheck className="h-4 w-4" />
                      )}
                      Marcar como Pagado
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {rows && rows.length > 0 ? (
        <p className="text-center text-xs text-muted-foreground">
          {pendingCount} pendiente{pendingCount === 1 ? "" : "s"} de confirmar
        </p>
      ) : null}
    </div>
  );
}

function Field({
  label,
  value,
}: {
  label: string;
  value?: string | null;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="truncate text-foreground" title={value || undefined}>
        {value?.trim() ? value : "—"}
      </p>
    </div>
  );
}
