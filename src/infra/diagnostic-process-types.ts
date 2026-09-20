export type DiagnosticMemoryUsage = {
  rssBytes: number;
  heapTotalBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  workerCount?: number;
  workerHeapSampledCount?: number;
  workerHeapTotalBytes?: number;
  workerHeapUsedBytes?: number;
};

export type DiagnosticChildProcessSpawnFields = {
  type: "diagnostic.child_process.spawn";
  family: string;
  count: number;
  intervalMs: number;
};
