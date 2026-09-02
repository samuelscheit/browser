import { createPostgresScheduler, type BrowserScheduler } from "@browser-fabric/control-plane";

export interface SchedulerServiceOptions {
  scheduler: BrowserScheduler;
  intervalMs?: number;
  onAssignments?(assignments: Awaited<ReturnType<BrowserScheduler["dispatch"]>>): Promise<void> | void;
}

/** Durable scheduler loop. Database locking is owned by BrowserScheduler transactions. */
export function startSchedulerService(options: SchedulerServiceOptions): { stop(): void; tick(): Promise<void> } {
  const intervalMs = options.intervalMs ?? 1_000;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await options.scheduler.recover();
      const assignments = await options.scheduler.dispatch();
      await options.onAssignments?.(assignments);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return { stop: () => clearInterval(timer), tick };
}

async function loadSecret(name: string): Promise<string> {
  const file = process.env[`${name}_FILE`];
  if (file) return (await Bun.file(file).text()).trim();
  const value = process.env[name];
  if (!value) throw new Error(`${name} or ${name}_FILE is required`);
  return value;
}

if (import.meta.main) {
  const runtime = await createPostgresScheduler({
    databaseUrl: await loadSecret("FABRIC_DB_URL"),
    capabilitySecret: await loadSecret("FABRIC_CAPABILITY_SECRET"),
    gatewayBaseUrl: process.env.FABRIC_GATEWAY_BASE_URL,
    poolSize: Number(process.env.FABRIC_DB_POOL_SIZE ?? 10),
    ssl: process.env.FABRIC_DB_SSL === "1"
  });
  const service = startSchedulerService({
    scheduler: runtime.scheduler,
    onAssignments: (assignments) => {
      if (assignments.length > 0) console.info(JSON.stringify({ event: "scheduler.assignments_dispatched", count: assignments.length }));
    }
  });
  const shutdown = () => { service.stop(); void runtime.close().finally(() => process.exit(0)); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  console.info("Browser Fabric scheduler started");
  await new Promise<void>(() => undefined);
}
