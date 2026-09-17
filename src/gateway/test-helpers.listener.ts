import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Socket } from "node:net";

/** Retain the exact loopback listener until the real Gateway transport adopts it. */
export async function reserveGatewayTestListener(port = 0) {
  const listener = createServer();
  const rejectEarlyConnection = (socket: Socket) => socket.destroy();
  listener.on("connection", rejectEarlyConnection);
  let adopted = false;
  const closeUnadopted = async () => {
    if (!adopted && listener.listening) {
      await new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(port, "127.0.0.1", () => {
        listener.off("error", reject);
        resolve();
      });
    });
    const address = listener.address();
    assert(address && typeof address !== "string");
    return {
      port: address.port,
      listener,
      closeUnadopted,
      async start<T>(run: () => Promise<T>): Promise<T> {
        const { vi } = await import("vitest");
        const transport = await import("./server-runtime-state.js");
        const createTransport = transport.createGatewayHttpTransport;
        const spy = vi
          .spyOn(transport, "createGatewayHttpTransport")
          .mockImplementation(async (params) => {
            if (params.port !== address.port) {
              return createTransport(params);
            }
            const runtime = await createTransport({ ...params, testListener: listener });
            adopted = true;
            return runtime;
          });
        try {
          const result = await run();
          listener.off("connection", rejectEarlyConnection);
          return result;
        } finally {
          spy.mockRestore();
        }
      },
    };
  } catch (error) {
    await closeUnadopted();
    throw error;
  }
}
