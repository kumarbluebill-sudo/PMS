import { Card, ErrorBanner, PageHeader } from "@/app/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import PropertyNav from "@/components/PropertyNav";
import { authorize } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { listCategories } from "@/server/services/property";
import RatePlanForm from "../RatePlanForm";

export default async function NewRatePlan({ searchParams }: PageProps<"/app/rates/new">) {
  const sp = await searchParams;
  const ctx = await getCtx();
  authorize(ctx, "rates.manage");
  const types = await listCategories(getDb(), ctx, { status: "active" });
  return (
    <>
      <Breadcrumbs items={[{ label: "Property management", href: "/app/property" }, { label: "Rate plans", href: "/app/rates" }, { label: "New rate plan" }]} />
      <PageHeader title="New rate plan" subtitle="A plan prices one or more categories for a period. Where plans overlap, the highest priority wins." />
      <PropertyNav current="rates" />
      <ErrorBanner message={typeof sp.error === "string" ? sp.error : undefined} />
      <Card><RatePlanForm types={types} /></Card>
    </>
  );
}
