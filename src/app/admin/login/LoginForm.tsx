"use client";

import { useActionState } from "react";
import { btnPrimary, input } from "@/components/ui";
import { loginAction } from "../actions";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(loginAction, null);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="next" value={next} />
      <label className="block text-xs">
        <span className="mb-1 block text-muted">Password</span>
        <input
          className={`${input} w-full text-sm`}
          type="password"
          name="password"
          autoComplete="current-password"
          required
          autoFocus
        />
      </label>
      {state?.error && <p className="text-xs text-red-700 dark:text-red-300">{state.error}</p>}
      <button type="submit" className={btnPrimary} disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
