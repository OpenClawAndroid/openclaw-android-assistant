import Foundation
import OpenClawProtocol

/// Coordinates a negotiated voice replacement; the call owner retains audio and transcript lifetimes.
@MainActor
public final class RealtimeTalkVoiceSelection {
    public private(set) var selectedVoice: String?
    public var isChanging: Bool {
        self.pendingChangeID != nil
    }

    private let sessionKey: String
    private let currentVoiceSessionID: @MainActor () -> String?
    private let isCurrent: @MainActor (RealtimeTalkVoiceSelection) -> Bool
    private let replace: @MainActor (TalkVoiceChangeEvent) async throws -> String
    private let complete: @MainActor (TalkVoiceCompleteParams) async throws -> Void
    private let cancel: @MainActor () async -> Void
    private let onFailure: @MainActor (Error) -> Void
    private let onApplied: @MainActor (String) -> Void
    private var active = true
    private var pendingChangeID: String?
    private var pendingVoiceSessionID: String?
    private var cancelledChangeID: String?
    private var cancellationTask: Task<Void, Never>?
    private var timeoutTask: Task<Void, Never>?

    public init(
        sessionKey: String,
        selectedVoice: String? = nil,
        currentVoiceSessionID: @escaping @MainActor () -> String?,
        isCurrent: @escaping @MainActor (RealtimeTalkVoiceSelection) -> Bool,
        replace: @escaping @MainActor (TalkVoiceChangeEvent) async throws -> String,
        complete: @escaping @MainActor (TalkVoiceCompleteParams) async throws -> Void,
        cancel: @escaping @MainActor () async -> Void,
        onFailure: @escaping @MainActor (Error) -> Void,
        onApplied: @escaping @MainActor (String) -> Void = { _ in })
    {
        self.sessionKey = sessionKey
        self.selectedVoice = selectedVoice
        self.currentVoiceSessionID = currentVoiceSessionID
        self.isCurrent = isCurrent
        self.replace = replace
        self.complete = complete
        self.cancel = cancel
        self.onFailure = onFailure
        self.onApplied = onApplied
    }

    public func handle(_ event: EventFrame) {
        guard self.active, self.isCurrent(self), event.event == "talk.voice.change",
              let payload = event.payload,
              let data = try? JSONEncoder().encode(payload),
              let change = try? JSONDecoder().decode(TalkVoiceChangeEvent.self, from: data),
              change.sessionkey == self.sessionKey,
              !change.changeid.isEmpty, !change.voicesessionid.isEmpty, !change.voice.isEmpty,
              let phase = change.phase.value as? String
        else { return }
        if phase == "cancelled" {
            self.cancelChange(change)
            return
        }
        guard phase == "requested", self.pendingChangeID == nil,
              self.currentVoiceSessionID() == change.voicesessionid
        else { return }
        self.pendingChangeID = change.changeid
        self.pendingVoiceSessionID = change.voicesessionid
        self.cancelledChangeID = nil
        self.cancellationTask = nil
        self.timeoutTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .seconds(60)) } catch { return }
            self?.cancelChange(change)
        }
        Task { @MainActor [weak self] in await self?.perform(change) }
    }

    private func cancelChange(_ change: TalkVoiceChangeEvent) {
        guard self.pendingChangeID == change.changeid,
              self.pendingVoiceSessionID == change.voicesessionid,
              self.cancelledChangeID != change.changeid
        else { return }
        self.timeoutTask?.cancel()
        self.timeoutTask = nil
        self.cancelledChangeID = change.changeid
        self.cancellationTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if self.pendingChangeID == change.changeid {
                    self.pendingChangeID = nil
                    self.pendingVoiceSessionID = nil
                }
            }
            guard self.active, self.isCurrent(self) else { return }
            await self.cancel()
            if self.active, self.isCurrent(self) { self.onFailure(CancellationError()) }
        }
    }

    public func invalidate() {
        self.timeoutTask?.cancel()
        self.timeoutTask = nil
        self.active = false
        self.pendingChangeID = nil
        self.pendingVoiceSessionID = nil
    }

    private func owns(_ change: TalkVoiceChangeEvent) -> Bool {
        self.active && self.isCurrent(self) && self.pendingChangeID == change.changeid &&
            self.cancelledChangeID != change.changeid
    }

    private func perform(_ change: TalkVoiceChangeEvent) async {
        var replacementID: String?
        do {
            guard self.owns(change) else { throw CancellationError() }
            let id = try await replace(change)
            replacementID = id
            guard self.owns(change), !id.isEmpty, id != change.voicesessionid,
                  self.currentVoiceSessionID() == id
            else { throw CancellationError() }
            try await self.complete(TalkVoiceCompleteParams(
                changeid: change.changeid,
                voicesessionid: id,
                outcome: AnyCodable("ready")))
            guard self.owns(change) else { return }
            self.selectedVoice = change.voice
            self.timeoutTask?.cancel()
            self.timeoutTask = nil
            self.pendingChangeID = nil
            self.pendingVoiceSessionID = nil
            self.onApplied(change.voice)
        } catch {
            if self.owns(change) {
                self.timeoutTask?.cancel()
                self.timeoutTask = nil
                self.cancelledChangeID = change.changeid
                await self.cancel()
                if self.pendingChangeID == change.changeid {
                    self.pendingChangeID = nil
                    self.pendingVoiceSessionID = nil
                }
                if self.active, self.isCurrent(self) {
                    self.onFailure(error)
                }
            }
            await self.cancellationTask?.value
            if self.pendingChangeID == change.changeid {
                self.pendingChangeID = nil
                self.pendingVoiceSessionID = nil
                self.timeoutTask?.cancel()
                self.timeoutTask = nil
            }
            // Closing first keeps the Gateway's replacement classification alive during teardown.
            try? await self.complete(TalkVoiceCompleteParams(
                changeid: change.changeid,
                voicesessionid: replacementID,
                outcome: AnyCodable("failed"),
                error: error.localizedDescription))
        }
    }
}
