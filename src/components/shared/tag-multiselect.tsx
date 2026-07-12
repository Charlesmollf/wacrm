"use client";

import { useState, useRef, useEffect } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { Tag } from "@/types";

interface TagMultiSelectProps {
  /** All tags available on the account. */
  allTags: Tag[];
  /** Ids of the tags currently applied. */
  selectedIds: string[];
  /** Toggle a tag on/off. */
  onToggle: (tagId: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

/**
 * Collapsible multi-select for tags. Renders a compact trigger that shows
 * the selected tags as colored chips; clicking it opens a panel with all
 * tags so several can be toggled at once. Keeps the tag list from taking
 * over the form/sidebar until the user wants to edit it.
 */
export function TagMultiSelect({
  allTags,
  selectedIds,
  onToggle,
  disabled,
  placeholder = "Seleccionar etiquetas",
}: TagMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const selected = allTags.filter((t) => selectedIds.includes(t.id));

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-lg border border-border bg-muted px-2.5 py-2 text-left outline-none focus:border-primary"
      >
        <div className="flex flex-1 flex-wrap gap-1">
          {selected.length === 0 ? (
            <span className="text-xs text-muted-foreground">{placeholder}</span>
          ) : (
            selected.map((tag) => (
              <span
                key={tag.id}
                className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{ backgroundColor: tag.color + "20", color: tag.color }}
              >
                {tag.name}
              </span>
            ))
          )}
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-border bg-popover p-2 shadow-lg">
          {allTags.length === 0 ? (
            <p className="px-1 py-1 text-xs text-muted-foreground">
              No hay etiquetas. Créalas en Ajustes → Campos y etiquetas.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {allTags.map((tag) => {
                const isSel = selectedIds.includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => onToggle(tag.id)}
                    className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium transition-all ${
                      isSel
                        ? "ring-2 ring-primary ring-offset-1 ring-offset-border"
                        : "opacity-50 hover:opacity-90"
                    }`}
                    style={{ backgroundColor: tag.color + "20", color: tag.color }}
                  >
                    {isSel && <Check className="mr-1 h-3 w-3" />}
                    {tag.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
