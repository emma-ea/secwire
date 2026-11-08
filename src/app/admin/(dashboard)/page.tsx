import type { Metadata } from "next";
import { Dashboard } from "@/components/admin/Dashboard";
import { getDashboardStatus } from "@/ingest/dashboard";
import { getSchedulerState } from "@/ingest/scheduler-service";
import { requireAdmin } from "@/lib/auth";

export const metadata: Metadata = { title: "Admin" };

export default async function AdminPage() {
  // Layouts and pages render in parallel, so the page checks too.
  await requireAdmin();
  const [status, scheduler] = await Promise.all([getDashboardStatus(), getSchedulerState()]);
  return <Dashboard initialStatus={status} scheduler={scheduler} />;
}
