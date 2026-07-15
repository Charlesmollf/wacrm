"use client";

import { useAuth } from "@/hooks/use-auth";
import { QuickActions } from "@/components/dashboard/quick-actions";
import { MomentumChart } from "@/components/dashboard/momentum-chart";
import {
  ConversationsVsSalesChart,
  NewContactsChart,
  PipelineValueBars,
  RecentPurchases,
} from "@/components/dashboard/dashboard-insights";
import { useTranslations } from "next-intl";

export default function DashboardPage() {
  const t = useTranslations("Dashboard.page");
  const { defaultCurrency } = useAuth();

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>

      {/* Quick actions */}
      <QuickActions />

      {/* Conversaciones vs Ventas + Nuevos contactos (líneas, 30 días) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ConversationsVsSalesChart />
        <NewContactsChart />
      </div>

      {/* Valor del pipeline por columna (barras) */}
      <PipelineValueBars currency={defaultCurrency} />

      {/* Momentum / proyección de cierre de mes */}
      <MomentumChart />

      {/* Compras recientes (reemplaza el feed de actividad) */}
      <RecentPurchases currency={defaultCurrency} />
    </div>
  );
}
