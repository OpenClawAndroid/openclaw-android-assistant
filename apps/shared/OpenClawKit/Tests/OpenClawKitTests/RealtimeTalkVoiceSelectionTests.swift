import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawKit

@MainActor
struct RealtimeTalkVoiceSelectionTests {
    private func event(
        phase: String = "requested",
        changeID: String = "change-1",
        sessionKey: String = "chat-1",
        voiceSessionID: String = "old-call") -> EventFrame
    {
        EventFrame(type: "event", event: "talk.voice.change", payload: AnyCodable([
            "changeId": changeID, "sessionKey": sessionKey, "voiceSessionId": voiceSessionID,
            "voice": "alloy", "phase": phase,
        ]))
    }

    @Test(arguments: [false, true])
    func `replacement waits for close and provider readiness and ignores late Stop completion`(
        stopped: Bool) async throws
    {
        let closing = RealtimeRelayStartupBarrier()
        let readiness = RealtimeRelayStartupBarrier()
        let completed = RealtimeRelayTestSignal<TalkVoiceCompleteParams>()
        var currentID: String? = "old-call"
        var replacements = 0
        var completions: [TalkVoiceCompleteParams] = []
        var applied: [String] = []
        let selection = RealtimeTalkVoiceSelection(
            sessionKey: "chat-1",
            selectedVoice: "marin",
            currentVoiceSessionID: { currentID },
            isCurrent: { _ in true },
            replace: { _ in
                replacements += 1
                await closing.suspend()
                currentID = "new-call"
                await readiness.suspend()
                return "new-call"
            },
            complete: { params in completions.append(params)
                completed.send(params)
            },
            cancel: { currentID = nil },
            onFailure: { _ in Issue.record("Unexpected current-owner failure") },
            onApplied: { applied.append($0) })
        defer { selection.invalidate() }

        selection.handle(self.event(sessionKey: "other-chat"))
        selection.handle(self.event(voiceSessionID: "another-call"))
        selection.handle(self.event(phase: "unknown"))
        #expect(replacements == 0)
        selection.handle(self.event())
        try await closing.waitUntilEntered()
        #expect(selection.isChanging)
        #expect(completions.isEmpty)
        selection.handle(self.event(changeID: "overlapping"))
        #expect(replacements == 1)
        await closing.release()
        try await readiness.waitUntilEntered()
        #expect(completions.isEmpty)
        #expect(selection.selectedVoice == "marin")
        if stopped {
            selection.invalidate()
            currentID = "another-call"
        }
        await readiness.release()
        let result = try await completed.next("voice completion")
        #expect(result.changeid == "change-1")
        #expect(result.outcome.stringValue == (stopped ? "failed" : "ready"))
        if stopped {
            #expect(currentID == "another-call")
            #expect(applied.isEmpty)
            #expect(selection.selectedVoice == "marin")
        } else {
            // The completion closure resumes before the handler commits its result.
            await Task.yield()
            #expect(selection.selectedVoice == "alloy")
            #expect(applied == ["alloy"])
        }
    }

    @Test func `matching server cancellation closes before reporting failure and cannot cancel a newer operation`() async throws {
        let ready = RealtimeRelayStartupBarrier()
        let closed = RealtimeRelayStartupBarrier()
        let completed = RealtimeRelayTestSignal<TalkVoiceCompleteParams>()
        var currentID: String? = "old-call"
        var replacements = 0
        var cancellations = 0
        var completions: [TalkVoiceCompleteParams] = []
        let selection = RealtimeTalkVoiceSelection(
            sessionKey: "chat-1",
            currentVoiceSessionID: { currentID },
            isCurrent: { _ in true },
            replace: { _ in
                replacements += 1
                await ready.suspend()
                return "replacement"
            },
            complete: { value in completions.append(value)
                completed.send(value)
            },
            cancel: { cancellations += 1
                await closed.suspend()
                currentID = nil
            },
            onFailure: { _ in })
        defer { selection.invalidate() }
        selection.handle(self.event())
        try await ready.waitUntilEntered()
        selection.handle(self.event(phase: "cancelled", changeID: "unrelated"))
        #expect(cancellations == 0)
        selection.handle(self.event(phase: "cancelled"))
        try await closed.waitUntilEntered()
        selection.handle(self.event(changeID: "new-change"))
        #expect(replacements == 1)
        await ready.release()
        await Task.yield()
        #expect(completions.isEmpty)
        await closed.release()
        let result = try await completed.next("cancelled voice completion")
        #expect(result.outcome.stringValue == "failed")
        #expect(cancellations == 1)
        #expect(selection.selectedVoice == nil)
    }

    @Test func `a failed replacement closes its transport before reporting a terminal error`() async throws {
        let closed = RealtimeRelayStartupBarrier()
        let completed = RealtimeRelayTestSignal<TalkVoiceCompleteParams>()
        var currentID: String? = "old-call"
        var failures = 0
        let selection = RealtimeTalkVoiceSelection(
            sessionKey: "chat-1",
            currentVoiceSessionID: { currentID },
            isCurrent: { _ in true },
            replace: { _ in throw URLError(.cannotConnectToHost) },
            complete: { completed.send($0) },
            cancel: { await closed.suspend()
                currentID = nil
            },
            onFailure: { _ in failures += 1 })
        defer { selection.invalidate() }
        selection.handle(self.event())
        try await closed.waitUntilEntered()
        #expect(failures == 0)
        await closed.release()
        let result = try await completed.next("failed voice completion")
        #expect(result.outcome.stringValue == "failed")
        #expect(result.voicesessionid == nil)
        #expect(failures == 1)
        #expect(selection.selectedVoice == nil)
    }
}
