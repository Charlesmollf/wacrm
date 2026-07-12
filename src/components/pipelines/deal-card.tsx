"use client";

import type { Deal, PipelineStage } from "@/types";
import { useRouter } from "next/navigation";
import { Calendar, Check, X } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { useTranslations } from "next-intl";

interface DealCardProps {
  deal: Deal;
  stage: PipelineStage | null;
  onEdit: (deal: Deal) => void;
  isOverlay?: boolean;
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function initials(name?: string, fallback?: string) {
  const source = (name || fallback || "?").trim();
  if (!source) return "?";
  return source.charAt(0).toUpperCase();
}

export function DealCard({ deal, stage, onEdit, isOverlay }: DealCardProps) {
  const t = useTranslations("Pipelines.card");
  const titleLabel = deal.contact?.name || deal.contact?.phone || deal.title;
  // Small secondary row: show the phone when we already used the name as the
  // title, otherwise fall back to the deal title / placeholder.
  const subLabel =
    deal.contact?.name && deal.contact?.phone
      ? deal.contact.phone
      : deal.title || t("noContact");
  const assigneeLabel = deal.assignee?.full_name || null;
  const router = useRouter();

  // Response-due traffic light: the lead is waiting when its last message
  // was inbound (customer) and no one has replied since. Colour by how long
  // it has been waiting: >5min green, >1h amber, >10h red.
  const conv = deal.conv;
  let light: { color: string; label: string } | null = null;
  if (conv?.last_inbound_at) {
    const inbound = new Date(conv.last_inbound_at).getTime();
    const outbound = conv.last_outbound_at
      ? new Date(conv.last_outbound_at).getTime()
      : 0;
    if (inbound > outbound) {
      const mins = (Date.now() - inbound) / 60000;
      if (mins > 600) light = { color: "#ef4444", label: "Sin responder +10h" };
      else if (mins > 60) light = { color: "#eab308", label: "Sin responder +1h" };
      else if (mins > 5) light = { color: "#22c55e", label: "Sin responder +5min" };
    }
  }
  // Human badge: shown when the AI is NOT handling this lead (paused here or
  // assigned to a person) so it is being attended manually.
  const human = !!(conv?.ai_autoreply_disabled || conv?.assigned_agent_id);

  return (
    <button
      type="button"
      onClick={(e) => {
        // `onClick` still fires after a non-drag tap because the PointerSensor
        // requires 5px movement before it counts as a drag.
        if (isOverlay) return;
        e.stopPropagation();
        onEdit(deal);
      }}
      className={`group relative w-full cursor-pointer rounded-xl border border-border/50 bg-muted/70 pl-4 pr-3 py-3 text-left shadow-sm transition-all ${
        isOverlay
          ? "shadow-xl"
          : "hover:-translate-y-0.5 hover:border-border hover:bg-muted hover:shadow-lg"
      }`}
    >
      {/* 4px left accent bar using stage color */}
      <span
        aria-hidden
        className="absolute left-0 top-0 h-full w-1 rounded-l-xl"
        style={{ backgroundColor: stage?.color ?? "#94a3b8" }}
      />

      <div className="flex items-start justify-between gap-2">
        <h4 className="flex-1 text-sm font-semibold leading-snug text-foreground break-words">
          {titleLabel}
        </h4>
        {human && (
          <span
            title="Atendido por un humano"
            className="shrink-0 text-xs leading-none"
          >
            🧑
          </span>
        )}
        {light && (
          <span
            aria-hidden
            title={light.label}
            className="mt-1 size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: light.color }}
          />
        )}
        {deal.grind && (
          <span className="inline-flex shrink-0 items-center rounded-full bg-amber-900/25 px-2 py-0.5 text-[10px] font-medium text-amber-300/90 ring-1 ring-amber-700/30">
            {deal.grind}
          </span>
        )}
        {deal.status === "won" && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
            <Check className="h-3 w-3" />
            {t("won")}
          </span>
        )}
        {deal.status === "lost" && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-400">
            <X className="h-3 w-3" />
            {t("lost")}
          </span>
        )}
      </div>

      {/* Contact row */}
      <div className="mt-2 flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-foreground">
          {initials(deal.contact?.name, deal.contact?.phone)}
        </span>
        {conv?.id ? (
          <span
            role="link"
            title="Abrir chat"
            onClick={(e) => {
              e.stopPropagation();
              router.push(`/inbox?c=${conv.id}`);
            }}
            className="truncate cursor-pointer text-xs text-primary hover:underline"
          >
            {subLabel}
          </span>
        ) : (
          <span className="truncate text-xs text-muted-foreground">{subLabel}</span>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between">
        <span className="text-sm font-bold text-primary">
          {formatCurrency(deal.value, deal.currency)}
        </span>
        {deal.expected_close_date && (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Calendar className="h-3 w-3" />
            {formatDate(deal.expected_close_date)}
          </span>
        )}
      </div>

      {(deal.payment_status || deal.payment_method) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {deal.payment_status && (
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                deal.payment_status === "Pagado"
                  ? "bg-emerald-500/15 text-emerald-400"
                  : "bg-amber-500/15 text-amber-400"
              }`}
            >
              {deal.payment_status}
            </span>
          )}
          {deal.payment_method && (
            <span className="inline-flex items-center rounded-full bg-foreground/10 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {deal.payment_method}
            </span>
          )}
        </div>
      )}

      {deal.contact?.tags && deal.contact.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {deal.contact.tags.map((tag) => (
            <span
              key={tag.id}
              className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
              style={{ backgroundColor: tag.color + "20", color: tag.color }}
            >
              {tag.name}
            </span>
          ))}
        </div>
      )}

      {assigneeLabel && (
        <div className="mt-2 flex items-center justify-end">
          <span
            title={assigneeLabel}
            className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary"
          >
            {initials(assigneeLabel)}
          </span>
        </div>
      )}
    </button>
  );
}
