import SwiftUI

struct ChatSubagentActivityList: View {
    @Environment(\.openClawChatDesktopLayout) private var isDesktopLayout
    let activities: [ChatSubagentActivity]
    let hiddenWorkingCount: Int

    var body: some View {
        VStack(alignment: .leading, spacing: self.isDesktopLayout ? 6 : 2) {
            ForEach(self.activities) { activity in
                ChatSubagentActivityRow(activity: activity)
            }
            if self.hiddenWorkingCount > 0 {
                Text(verbatim: String(
                    format: String(localized: "+%1$lld more working"),
                    Int64(self.hiddenWorkingCount)))
                    .font(OpenClawChatTypography.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 35)
            }
        }
        .padding(4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ChatSubagentActivityRow: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openClawChatDesktopLayout) private var isDesktopLayout
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @State private var expanded = false

    let activity: ChatSubagentActivity

    private var detail: String? {
        if self.activity.status.isWorking {
            return self.activity.snippet
        }
        return self.activity.terminalSummary ?? self.activity.snippet
    }

    private var title: LocalizedStringResource {
        switch self.activity.status {
        case .queued:
            "Subagent queued"
        case .running:
            "Subagent working"
        case .completed:
            "Subagent finished"
        case .failed, .timedOut:
            "Subagent failed"
        case .cancelled:
            "Subagent cancelled"
        }
    }

    private var titleColor: Color {
        switch self.activity.status {
        case .failed, .timedOut:
            OpenClawChatTheme.danger
        case .queued, .running, .completed, .cancelled:
            self.isDesktopLayout
                ? OpenClawChatTheme.desktopText(in: self.colorScheme, contrast: self.colorSchemeContrast)
                : OpenClawChatTheme.assistantText
        }
    }

    private var statusLabel: LocalizedStringResource {
        switch self.activity.status {
        case .queued: "Queued"
        case .running: "Working"
        case .completed: "Finished"
        case .failed, .timedOut: "Failed"
        case .cancelled: "Cancelled"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if self.isDesktopLayout, self.detail != nil {
                Button {
                    withAnimation(self.reduceMotion ? nil : .easeOut(duration: 0.15)) {
                        self.expanded.toggle()
                    }
                } label: {
                    self.summary
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityValue(self.expanded ? "Expanded" : "Collapsed")
                .accessibilityIdentifier("chat-subagent-activity-\(self.activity.id)")
            } else {
                self.summary
            }
            if self.isDesktopLayout, self.expanded, let detail = self.detail {
                Text(verbatim: detail)
                    .font(OpenClawChatTypography.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .padding(.leading, 35)
            }
        }
        .modifier(ChatWorkCardStyle())
    }

    private var summary: some View {
        HStack(alignment: .center, spacing: 7) {
            if self.activity.status == .running {
                ChatWorkingClawView(seed: self.activity.id)
            } else {
                Image(systemName: self.statusSymbol)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(
                        self.activity.status == .completed
                            ? OpenClawChatTheme.success
                            : self.activity.status == .cancelled || self.activity.status == .queued
                            ? Color.secondary
                            : OpenClawChatTheme.danger)
                    .frame(width: 28, height: 24)
                    .accessibilityHidden(true)
            }

            (self.activity.title.map { Text(verbatim: $0) } ?? Text(self.title))
                .font(OpenClawChatTypography.footnoteSemiBold)
                .foregroundStyle(self.titleColor)
                .lineLimit(1)
                .help(self.activity.title ?? String(localized: self.title))

            if self.activity.title != nil {
                Text(self.statusLabel)
                    .font(OpenClawChatTypography.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize()
            }

            if let detail = self.detail {
                Text(verbatim: detail)
                    .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .contentTransition(.opacity)
                    .animation(
                        self.reduceMotion ? nil : .easeOut(duration: 0.16),
                        value: detail)
            }

            if let stat = self.activity.diffStat {
                ChatDiffStatChips(stat: stat)
            }

            Spacer(minLength: 0)
            if self.isDesktopLayout, self.detail != nil {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(self.expanded ? 90 : 0))
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }

    private var statusSymbol: String {
        switch self.activity.status {
        case .queued: "hourglass"
        case .running: "circle.dotted"
        case .completed: "checkmark"
        case .cancelled: "stop.circle"
        case .failed, .timedOut: "exclamationmark.triangle"
        }
    }
}
