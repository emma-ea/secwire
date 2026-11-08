import { defineConfig } from "drizzle-kit";

// drizzle-kit doesn't load .env itself; Node ≥ 21.7 can.
try {
  process.loadEnvFile(".env");
} catch {
  // No .env file — rely on the real environment.
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  casing: "snake_case",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
