import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { btn } from "@/components/ui";
import { logoutAction } from "../actions";

export const metadata: Metadata = { robots: { index: false } };

/**
 * The admin auth boundary for pages (SPEC §10). Lives in the (dashboard) route
 * group so /admin/login stays outside it; proxy.ts redirects are only a
 * convenience.
 */
export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  await requireAdmin();
  return (
    <div>
      <div className="mb-3 flex justify-end">
        <form action={logoutAction}>
          <button type="submit" className={btn}>
            Log out
          </button>
        </form>
      </div>
      {children}
    </div>
  );
}
