/**
 * Post-commit hook for runSource (SPEC §6.2 step 5). Phase 2 enqueues
 * enrich.cve for new/stale CVEs and cluster.items here. Phase 1: no-op.
 */
export async function afterIngest(_event: {
  sourceId: string;
  newCveIds: string[];
  itemIds: string[];
}): Promise<void> {}
