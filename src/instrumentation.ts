/**
 * Runs once when the Next.js server starts. Validates the environment so a
 * misconfigured deployment fails at boot instead of on the first request.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getEnv } = await import("./env");
    getEnv();
  }
}
