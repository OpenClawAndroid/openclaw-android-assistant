export function dryRunMessageToolEvents(): Record<string, unknown>[] {
  return [
    {
      id: "dry-run-call",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "dry-run-call",
            name: "message",
            arguments: {
              action: "send",
              message: "Dry run",
              status: "dry_run",
            },
          },
        ],
      },
      type: "message",
    },
    {
      id: "dry-run-result",
      message: {
        role: "toolResult",
        toolCallId: "dry-run-call",
        toolName: "message",
        result: { ok: true },
      },
      type: "message",
    },
    {
      id: "dry-run-flush",
      message: { role: "assistant", content: "NO_REPLY" },
      type: "message",
    },
  ];
}

export function dryRunMessageToolResultEvents(): Record<string, unknown>[] {
  return [
    {
      id: "dry-result-call",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "dry-result-call",
            name: "message",
            arguments: { action: "send", message: "Dry result" },
          },
        ],
      },
      type: "message",
    },
    {
      id: "dry-result",
      message: {
        role: "toolResult",
        toolCallId: "dry-result-call",
        toolName: "message",
        result: { status: "dry_run" },
      },
      type: "message",
    },
    {
      id: "dry-result-flush",
      message: { role: "assistant", content: "NO_REPLY" },
      type: "message",
    },
  ];
}
