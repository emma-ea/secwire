import type { Metadata } from "next";
import Link from "next/link";
import { NewSourceForm } from "@/components/admin/NewSourceForm";
import { requireAdmin } from "@/lib/auth";

export const metadata: Metadata = { title: "Add source" };

export default async function NewSourcePage() {
  await requireAdmin();
  return (
    <div className="max-w-4xl space-y-3">
      <Link href="/admin" className="text-xs text-muted hover:text-foreground">
        ← Admin
      </Link>
      <h1 className="text-base font-semibold">Add source</h1>
      <p className="text-xs text-muted">
        Run a successful Test before saving. Testing fetches and parses the feed once (20s timeout) and stores nothing.
      </p>
      <NewSourceForm />
    </div>
  );
}
