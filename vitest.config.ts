import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The forks pool intermittently reports ERR_IPC_CHANNEL_CLOSED after all
    // tests pass on Linux. One worker thread avoids child-process IPC teardown
    // while keeping the native runtimes isolated from Vitest's main process.
    pool: "threads",
    fileParallelism: false,
    maxWorkers: 1,
  },
});
