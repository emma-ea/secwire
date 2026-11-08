import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Admin login", robots: { index: false } };

export default async function LoginPage({ searchParams }: PageProps<"/admin/login">) {
  if (await isAdmin()) redirect("/admin");
  const { next } = await searchParams;
  return (
    <div className="mx-auto mt-16 max-w-xs">
      <h1 className="mb-4 text-base font-semibold">Admin login</h1>
      <LoginForm next={typeof next === "string" ? next : ""} />
    </div>
  );
}
