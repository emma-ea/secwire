import type { z } from "zod";

/** Parses a JSON body against a schema. Returns the data or a 400 Response. */
export async function readJson<S extends z.ZodType>(
  req: Request,
  schema: S,
): Promise<{ data: z.infer<S>; error?: never } | { data?: never; error: Response }> {
  let body: unknown;
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return { error: Response.json({ error: "Body must be valid JSON" }, { status: 400 }) };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      error: Response.json(
        {
          error: "Invalid request body",
          issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
        { status: 400 },
      ),
    };
  }
  return { data: parsed.data };
}

export const noStore = { "Cache-Control": "no-store" } as const;

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: noStore });
}
