export interface DataFileHost {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

/**
 * Serializes all reads/writes to the plugin's single data.json file.
 *
 * Obsidian's `loadData`/`saveData` are plain read-whole-file/write-whole-file
 * calls. Both KnowFlowSettings and KnowledgeStore persist into the same file
 * under different top-level keys, and previously each did its own independent
 * "read -> merge -> write" round trip. If a settings save and a store save
 * happened to overlap (e.g. the user tweaks a setting while a background AI
 * summary finishes), the second write could clobber the first with a stale
 * snapshot, silently losing data. Routing every mutation through this queue
 * makes each update see the result of all previously queued updates.
 */
export class PluginDataManager {
  private queue: Promise<void> = Promise.resolve();

  constructor(private host: DataFileHost) {}

  async read(): Promise<Record<string, unknown>> {
    const data = await this.host.loadData();
    return data && typeof data === "object" ? { ...(data as Record<string, unknown>) } : {};
  }

  update(mutate: (root: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>): Promise<void> {
    const task = this.queue.then(async () => {
      const root = await this.read();
      const next = await mutate(root);
      await this.host.saveData(next);
    });
    this.queue = task.catch((error) => {
      console.error("KnowFlow: failed to persist plugin data", error);
    });
    return task;
  }
}
