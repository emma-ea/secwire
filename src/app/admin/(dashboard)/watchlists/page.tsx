import type { Metadata } from "next";
import Link from "next/link";
import { WatchlistsManager } from "@/components/admin/WatchlistsManager";
import { channelStatus, listWatchlists, recentDeliveries } from "@/ingest/alerts";
import { requireAdmin } from "@/lib/auth";

export const metadata: Metadata = { title: "Watchlists" };

export default async function WatchlistsPage() {
  await requireAdmin();
  const [watchlists, deliveries] = await Promise.all([listWatchlists(), recentDeliveries(30)]);
  const channels = channelStatus();
  return (
    <div className="max-w-5xl space-y-4">
      <Link href="/admin" className="text-xs text-muted hover:text-foreground">
        ← Admin
      </Link>
      <h1 className="text-base font-semibold">Watchlists</h1>
      <p className="max-w-3xl text-xs text-muted">
        A story matches when a term appears in a linked CVE&apos;s vendor or product (KEV, else NVD), or as a whole word in the story
        title, and it passes the filters. Each story alerts once per watchlist, plus once more if it later enters CISA KEV. Stories
        that already match when you save are not alerted.
      </p>
      <WatchlistsManager
        watchlists={watchlists.map((w) => ({ ...w, createdAt: w.createdAt.toISOString(), updatedAt: w.updatedAt.toISOString() }))}
        channels={channels}
        deliveries={deliveries.map((d) => ({ ...d, created_at: d.created_at.toISOString() }))}
      />
    </div>
  );
}
