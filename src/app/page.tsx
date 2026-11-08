export default function Home() {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10 font-mono text-sm">
      <h1 className="text-lg font-semibold">SecWire</h1>
      <p className="mt-2 text-foreground/70">
        Security news aggregator. The feed arrives in Phase 1 — see{" "}
        <a className="underline" href="/api/health">
          /api/health
        </a>{" "}
        for system status.
      </p>
    </main>
  );
}
