"use client";

import Form from "next/form";
import Link from "next/link";
import type { ChangeEvent } from "react";
import { btn, input } from "@/components/ui";
import { CATEGORIES, MIN_CVSS_OPTIONS, RANGES, SORTS, type FeedFilters } from "@/feed/params";
import type { FilterOptions } from "@/feed/queries";

/**
 * Feed filters as a GET form (SPEC §8): every filter is a URL search param,
 * so views are shareable and the form works without JavaScript. With JS,
 * selects and the checkbox apply immediately via client-side navigation.
 */
export function FilterBar({ filters, options, active }: { filters: FeedFilters; options: FilterOptions; active: boolean }) {
  const submit = (e: ChangeEvent<HTMLSelectElement | HTMLInputElement>) => e.currentTarget.form?.requestSubmit();
  const select = `${input} pr-6`;

  return (
    <Form action="/" className="flex flex-wrap items-center gap-2 text-xs" aria-label="Filter stories">
      <input
        type="search"
        name="q"
        defaultValue={filters.q ?? ""}
        placeholder="Search stories, or a CVE id"
        aria-label="Search"
        className={`${input} w-56`}
      />
      <select name="range" defaultValue={filters.range} onChange={submit} aria-label="Time range" className={select}>
        {Object.keys(RANGES).map((r) => (
          <option key={r} value={r}>
            Last {r}
          </option>
        ))}
      </select>
      <label className="inline-flex items-center gap-1">
        <input type="checkbox" name="kev" value="1" defaultChecked={filters.kev} onChange={submit} />
        KEV only
      </label>
      <select name="minCvss" defaultValue={filters.minCvss ?? ""} onChange={submit} aria-label="Minimum CVSS" className={select}>
        <option value="">Any CVSS</option>
        {MIN_CVSS_OPTIONS.map((n) => (
          <option key={n} value={n}>
            CVSS ≥ {n}
          </option>
        ))}
      </select>
      <select name="category" defaultValue={filters.category ?? ""} onChange={submit} aria-label="Source category" className={select}>
        <option value="">All categories</option>
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <select name="source" defaultValue={filters.source ?? ""} onChange={submit} aria-label="Source" className={select}>
        <option value="">All sources</option>
        {options.sources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <input
        name="vendor"
        defaultValue={filters.vendor ?? ""}
        placeholder="Vendor"
        aria-label="Vendor"
        list="vendor-options"
        className={`${input} w-36`}
      />
      <datalist id="vendor-options">
        {options.vendors.map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
      <select name="sort" defaultValue={filters.sort} onChange={submit} aria-label="Sort" className={select}>
        {Object.entries(SORTS).map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </select>
      <button type="submit" className={btn}>
        Apply
      </button>
      {active && (
        <Link href="/" className="text-muted hover:text-foreground hover:underline">
          Reset
        </Link>
      )}
    </Form>
  );
}
