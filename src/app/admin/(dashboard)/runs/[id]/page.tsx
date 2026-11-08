import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RunDetail, type RunDetailData } from "@/components/admin/RunDetail";
import { getDb } from "@/db/client";
import { getRun } from "@/ingest/runs";
import { requireAdmin } from "@/lib/auth";

export const metadata: Metadata = { title: "Run" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function RunPage({ params }: PageProps<"/admin/runs/[id]">) {
  await requireAdmin();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const run = await getRun(getDb(), id);
  if (!run) notFound();

  return (
    <div className="space-y-3">
      <Link href="/admin" className="text-xs text-muted hover:text-foreground">
        ← Admin
      </Link>
      <RunDetail initial={JSON.parse(JSON.stringify(run)) as RunDetailData} />
    </div>
  );
}
