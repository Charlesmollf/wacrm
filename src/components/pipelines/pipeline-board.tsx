"use client";

import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  closestCorners,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { Deal, PipelineStage, Tag } from "@/types";
import { DealCard } from "./deal-card";
import { Button } from "@/components/ui/button";
import { Plus, Check, X, Loader2 } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { formatCurrency } from "@/lib/currency";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

interface PipelineBoardProps {
  stages: PipelineStage[];
  deals: Deal[];
  onDealMoved: (dealId: string, newStageId: string) => void;
  onAddDeal: (stageId: string) => void;
  onEditDeal: (deal: Deal) => void;
  allTags: Tag[];
  onReload: () => void;
}

export function PipelineBoard({
  stages,
  deals,
  onDealMoved,
  onAddDeal,
  onEditDeal,
  allTags,
  onReload,
}: PipelineBoardProps) {
  const { defaultCurrency } = useAuth();
  const [activeDealId, setActiveDealId] = useState<string | null>(null);

  // Bulk-selection state: a set of selected deal ids across all columns.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const toggleOne = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const setMany = (ids: string[], on: boolean) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const clearSelection = () => setSelectedIds(new Set());

  const sortedStages = useMemo(
    () => [...stages].sort((a, b) => a.position - b.position),
    [stages],
  );

  const dealsByStage = useMemo(() => {
    const map = new Map<string, Deal[]>();
    for (const stage of sortedStages) map.set(stage.id, []);
    for (const deal of deals) {
      const bucket = map.get(deal.stage_id);
      if (bucket) bucket.push(deal);
    }
    // Order each column by most recent inbound message (newest on top).
    const inboundTs = (d: Deal): number => {
      const t = d.conv?.last_inbound_at;
      return t ? new Date(t).getTime() : 0;
    };
    for (const bucket of map.values()) {
      bucket.sort((a, b) => inboundTs(b) - inboundTs(a));
    }
    return map;
  }, [sortedStages, deals]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const activeDeal = activeDealId
    ? deals.find((d) => d.id === activeDealId) ?? null
    : null;

  function handleDragStart(event: DragStartEvent) {
    setActiveDealId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDealId(null);
    const { active, over } = event;
    if (!over) return;
    const dealId = String(active.id);
    const targetStageId = String(over.id);
    const deal = deals.find((d) => d.id === dealId);
    if (!deal || deal.stage_id === targetStageId) return;
    if (!sortedStages.some((s) => s.id === targetStageId)) return;
    onDealMoved(dealId, targetStageId);
  }

  function handleDragCancel() {
    setActiveDealId(null);
  }

  // ---- Bulk actions -------------------------------------------------------
  async function runInChunks<T>(items: T[], size: number, fn: (chunk: T[]) => Promise<void>) {
    for (let i = 0; i < items.length; i += size) {
      await fn(items.slice(i, i + size));
    }
  }

  async function bulkMove(stageId: string) {
    const ids = [...selectedIds];
    if (ids.length === 0 || !stageId) return;
    setBulkBusy(true);
    const supabase = createClient();
    let failed = false;
    await runInChunks(ids, 100, async (chunk) => {
      const { error } = await supabase
        .from("deals")
        .update({ stage_id: stageId })
        .in("id", chunk);
      if (error) failed = true;
    });
    setBulkBusy(false);
    if (failed) {
      toast.error("No se pudieron mover algunos deals.");
    } else {
      const name = sortedStages.find((s) => s.id === stageId)?.name ?? "";
      toast.success(`${ids.length} movido(s) a ${name}.`);
    }
    clearSelection();
    onReload();
  }

  async function bulkTag(tagId: string) {
    const ids = [...selectedIds];
    if (ids.length === 0 || !tagId) return;
    const contactIds = [
      ...new Set(
        ids
          .map((id) => deals.find((d) => d.id === id)?.contact_id)
          .filter((c): c is string => !!c),
      ),
    ];
    if (contactIds.length === 0) {
      toast.error("Los deals seleccionados no tienen contacto.");
      return;
    }
    setBulkBusy(true);
    const supabase = createClient();
    let failed = false;
    await runInChunks(contactIds, 100, async (chunk) => {
      const rows = chunk.map((cid) => ({ contact_id: cid, tag_id: tagId }));
      const { error } = await supabase
        .from("contact_tags")
        .upsert(rows, { onConflict: "contact_id,tag_id" });
      if (error) failed = true;
    });
    setBulkBusy(false);
    if (failed) {
      toast.error("No se pudo etiquetar a algunos contactos.");
    } else {
      const name = allTags.find((t) => t.id === tagId)?.name ?? "";
      toast.success(`Etiqueta "${name}" aplicada a ${contactIds.length} contacto(s).`);
    }
    clearSelection();
    onReload();
  }

  async function bulkUntag(tagId: string) {
    const ids = [...selectedIds];
    if (ids.length === 0 || !tagId) return;
    const contactIds = [
      ...new Set(
        ids
          .map((id) => deals.find((d) => d.id === id)?.contact_id)
          .filter((c): c is string => !!c),
      ),
    ];
    if (contactIds.length === 0) {
      toast.error("Los deals seleccionados no tienen contacto.");
      return;
    }
    setBulkBusy(true);
    const supabase = createClient();
    let failed = false;
    await runInChunks(contactIds, 100, async (chunk) => {
      const { error } = await supabase
        .from("contact_tags")
        .delete()
        .eq("tag_id", tagId)
        .in("contact_id", chunk);
      if (error) failed = true;
    });
    setBulkBusy(false);
    if (failed) {
      toast.error("No se pudo quitar la etiqueta a algunos contactos.");
    } else {
      const name = allTags.find((t) => t.id === tagId)?.name ?? "";
      toast.success(`Etiqueta "${name}" quitada a ${contactIds.length} contacto(s).`);
    }
    clearSelection();
    onReload();
  }

  const selectedCount = selectedIds.size;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="pipeline-scroll flex snap-x snap-mandatory gap-3 overflow-x-auto pb-4 lg:snap-none">
        {sortedStages.map((stage) => {
          const stageDeals = dealsByStage.get(stage.id) ?? [];
          const totalValue = stageDeals.reduce(
            (s, d) => s + Number(d.value || 0),
            0,
          );
          return (
            <StageColumn
              key={stage.id}
              stage={stage}
              deals={stageDeals}
              totalValue={totalValue}
              currency={defaultCurrency}
              onAddDeal={onAddDeal}
              onEditDeal={onEditDeal}
              selectedIds={selectedIds}
              onToggleOne={toggleOne}
              onToggleColumn={setMany}
            />
          );
        })}
      </div>

      <DragOverlay
        dropAnimation={{ duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" }}
      >
        {activeDeal ? (
          <div className="opacity-90">
            <DealCard
              deal={activeDeal}
              stage={
                sortedStages.find((s) => s.id === activeDeal.stage_id) ?? null
              }
              onEdit={() => {}}
              isOverlay
            />
          </div>
        ) : null}
      </DragOverlay>

      {/* Bulk action bar — appears when at least one card is selected. */}
      {selectedCount > 0 ? (
        <div className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-popover px-3 py-2 shadow-2xl">
            {bulkBusy ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : null}
            <span className="text-sm font-medium text-foreground">
              {selectedCount} seleccionado{selectedCount === 1 ? "" : "s"}
            </span>

            <select
              defaultValue=""
              disabled={bulkBusy}
              onChange={(e) => {
                const v = e.target.value;
                e.target.value = "";
                if (v) bulkMove(v);
              }}
              className="h-8 rounded-lg border border-border bg-muted px-2 text-xs text-foreground outline-none focus:border-primary"
            >
              <option value="">Mover a…</option>
              {sortedStages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>

            <select
              defaultValue=""
              disabled={bulkBusy || allTags.length === 0}
              onChange={(e) => {
                const v = e.target.value;
                e.target.value = "";
                if (v) bulkTag(v);
              }}
              className="h-8 rounded-lg border border-border bg-muted px-2 text-xs text-foreground outline-none focus:border-primary"
            >
              <option value="">Etiquetar…</option>
              {allTags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>

            <select
              defaultValue=""
              disabled={bulkBusy || allTags.length === 0}
              onChange={(e) => {
                const v = e.target.value;
                e.target.value = "";
                if (v) bulkUntag(v);
              }}
              className="h-8 rounded-lg border border-border bg-muted px-2 text-xs text-foreground outline-none focus:border-primary"
            >
              <option value="">Quitar etiqueta…</option>
              {allTags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={clearSelection}
              disabled={bulkBusy}
              className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
              Cancelar
            </button>
          </div>
        </div>
      ) : null}

      <style jsx>{`
        .pipeline-scroll {
          scroll-behavior: smooth;
        }
        @media (hover: none), (pointer: coarse) {
          .pipeline-scroll::-webkit-scrollbar {
            height: 0;
            display: none;
          }
          .pipeline-scroll {
            scrollbar-width: none;
          }
        }
        @media (hover: hover) and (pointer: fine) {
          .pipeline-scroll {
            scrollbar-width: thin;
            scrollbar-color: var(--border) transparent;
          }
          .pipeline-scroll::-webkit-scrollbar {
            height: 8px;
          }
          .pipeline-scroll::-webkit-scrollbar-track {
            background: transparent;
          }
          .pipeline-scroll::-webkit-scrollbar-thumb {
            background-color: var(--border);
            border-radius: 9999px;
          }
          .pipeline-scroll::-webkit-scrollbar-thumb:hover {
            background-color: var(--muted-foreground);
          }
        }
      `}</style>
    </DndContext>
  );
}

function StageColumn({
  stage,
  deals,
  totalValue,
  currency,
  onAddDeal,
  onEditDeal,
  selectedIds,
  onToggleOne,
  onToggleColumn,
}: {
  stage: PipelineStage;
  deals: Deal[];
  totalValue: number;
  currency: string;
  onAddDeal: (stageId: string) => void;
  onEditDeal: (deal: Deal) => void;
  selectedIds: Set<string>;
  onToggleOne: (id: string) => void;
  onToggleColumn: (ids: string[], on: boolean) => void;
}) {
  const t = useTranslations("Pipelines.board");
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });

  const allSelected =
    deals.length > 0 && deals.every((d) => selectedIds.has(d.id));
  const someSelected = deals.some((d) => selectedIds.has(d.id));

  return (
    <div className="flex w-[85vw] min-w-[260px] max-w-[320px] shrink-0 snap-start flex-col rounded-xl border border-border bg-card/60 p-4 lg:w-auto lg:max-w-none lg:flex-1 lg:basis-[260px] lg:shrink lg:snap-none">
      <div
        className="-mx-4 -mt-4 h-[3px] rounded-t-xl"
        style={{ backgroundColor: stage.color }}
      />
      <div className="flex items-center justify-between pt-3">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            aria-label="Seleccionar toda la columna"
            onClick={() => onToggleColumn(deals.map((d) => d.id), !allSelected)}
            disabled={deals.length === 0}
            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
              allSelected
                ? "border-primary bg-primary text-primary-foreground"
                : someSelected
                  ? "border-primary bg-primary/30"
                  : "border-border bg-transparent hover:border-primary"
            } disabled:opacity-30`}
          >
            {allSelected ? <Check className="h-3 w-3" /> : null}
          </button>
          <h3 className="truncate text-sm font-semibold text-foreground">
            {stage.name}
          </h3>
        </div>
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {deals.length}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {formatCurrency(totalValue, currency)}
      </p>

      <div
        ref={setNodeRef}
        className={`mt-3 flex flex-1 flex-col gap-2 rounded-lg transition-all ${
          isOver
            ? "bg-primary/5 outline outline-2 outline-dashed outline-primary outline-offset-2"
            : ""
        }`}
      >
        {deals.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-lg border-2 border-dashed border-border py-10 text-xs text-muted-foreground">
            {t("dropDealHere")}
          </div>
        ) : (
          deals.map((deal) => (
            <DraggableDealCard
              key={deal.id}
              deal={deal}
              stage={stage}
              onEdit={onEditDeal}
              selected={selectedIds.has(deal.id)}
              onToggleSelect={onToggleOne}
            />
          ))
        )}
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={() => onAddDeal(stage.id)}
        className="mt-3 w-full justify-start border border-dashed border-border bg-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground"
      >
        <Plus className="mr-1 h-3 w-3" />
        {t("addDeal")}
      </Button>
    </div>
  );
}

function DraggableDealCard({
  deal,
  stage,
  onEdit,
  selected,
  onToggleSelect,
}: {
  deal: Deal;
  stage: PipelineStage;
  onEdit: (deal: Deal) => void;
  selected: boolean;
  onToggleSelect: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: deal.id,
  });

  return (
    <div className="group relative">
      {/* Selection checkbox — sibling of the draggable node so clicking
          it never starts a drag. Hidden until hover (or when selected)
          so it doesn't cover the contact name. */}
      <button
        type="button"
        aria-label="Seleccionar deal"
        onClick={() => onToggleSelect(deal.id)}
        className={`absolute left-1.5 top-1.5 z-20 flex h-5 w-5 items-center justify-center rounded border shadow-sm transition-opacity ${
          selected
            ? "border-primary bg-primary text-primary-foreground opacity-100"
            : "border-border bg-card/90 opacity-0 hover:border-primary group-hover:opacity-100"
        }`}
      >
        {selected ? <Check className="h-3.5 w-3.5" /> : null}
      </button>
      <div
        ref={setNodeRef}
        {...listeners}
        {...attributes}
        style={{ opacity: isDragging ? 0.3 : 1, touchAction: "none" }}
        className={selected ? "rounded-xl ring-2 ring-primary" : ""}
      >
        <DealCard deal={deal} stage={stage} onEdit={onEdit} />
      </div>
    </div>
  );
}
