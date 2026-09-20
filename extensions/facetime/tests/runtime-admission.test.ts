import { beforeEach, describe, expect, it } from "vitest";
import {
  createRuntime,
  createTalkDriver,
  incomingCall,
  mocks,
  resetRuntimeTestState,
} from "./runtime.test-support.js";

const verifiedTransport = incomingCall().data.transport;
const deniedCallData = [
  { name: "unlisted caller", data: { handle: { value: "unlisted@example.com" } } },
  {
    name: "cellular transport",
    data: {
      transport: {
        ...verifiedTransport,
        kind: "cellular",
        service: 1,
        provider_is_facetime: false,
        provider_is_telephony: true,
      },
    },
  },
  {
    name: "baseband transport",
    data: { transport: { ...verifiedTransport, is_using_baseband: true } },
  },
  {
    name: "Wi-Fi calling transport",
    data: { transport: { ...verifiedTransport, is_wifi_call: true } },
  },
  {
    name: "unclassified transport",
    data: { transport: { ...verifiedTransport, provider_classified: false } },
  },
  { name: "missing transport", data: { transport: undefined } },
];

describe("FaceTime runtime admission", () => {
  beforeEach(resetRuntimeTestState);

  describe.each([
    { phase: "ringing", status: 4 },
    { phase: "active", status: 1 },
  ])("$phase calls", ({ status }) => {
    it.each(deniedCallData)("rejects $name before media or agent effects", async ({ data }) => {
      const talk = createTalkDriver({});
      mocks.startTalk.mockResolvedValue(talk);
      const runtime = await createRuntime();
      try {
        const helperParams = mocks.helperParams;
        if (!helperParams) {
          throw new Error("Runtime did not register its helper event handler");
        }
        const event = incomingCall(status);
        helperParams.onMessage({ ...event, data: { ...event.data, ...data } });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });

        expect((await runtime.status()).calls).toEqual([]);
        expect(mocks.startTalk).not.toHaveBeenCalled();
        expect(talk.readyForAudio).not.toHaveBeenCalled();
        expect(talk.activate).not.toHaveBeenCalled();
        expect(mocks.helper.answerCall).not.toHaveBeenCalled();
        expect(mocks.helper.safetyMute).not.toHaveBeenCalled();
        expect(mocks.helper.setMuted).not.toHaveBeenCalled();
        expect(mocks.helper.startTransmission).not.toHaveBeenCalled();
      } finally {
        await runtime.stop();
      }
    });
  });
});
