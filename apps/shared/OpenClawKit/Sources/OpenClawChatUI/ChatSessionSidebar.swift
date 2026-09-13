#if os(macOS)
import AppKit
import SwiftUI

extension ChatSessionSidebarModel.Node {
    fileprivate var outlineChildren: [Self]? {
        self.children.isEmpty ? nil : self.children
    }
}

@MainActor
struct ChatSessionSidebar: View {
    @Bindable var viewModel: OpenClawChatViewModel
    @Binding var query: String
    @State private var sessionPendingDeletion: OpenClawChatSessionEntry?
    @State private var sessionPendingRename: OpenClawChatSessionEntry?
    @State private var renameText = ""
    @State private var groups: [OpenClawChatSessionGroup] = []
    @State private var groupRefreshNonce = 0
    @State private var groupLoadFailed = false
    @State private var inspectedSession: OpenClawChatSessionEntry?
    @State private var isPresentingNewSessionOptions = false
    @AppStorage("openclaw.chat.collapsedSessionGroups") private var collapsedSessionGroups = ""

    var body: some View {
        let sections = ChatSessionSidebarModel.sections(
            sessions: self.viewModel.sessions,
            currentSessionKey: self.viewModel.sessionKey,
            mainSessionKey: self.viewModel.selectedAgentMainSessionKey,
            activeAgentID: self.viewModel.selectedAgentID,
            groups: self.groups,
            query: self.query,
            sessionRoutingContract: self.viewModel.agentCatalog?.sessionRoutingContract ??
                self.viewModel.sessionRoutingContract)
        List(selection: self.selectionBinding) {
            self.newThreadButton
                .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 16, trailing: 0))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .selectionDisabled()
            self.agentsSection
            ForEach(sections) { section in
                if section.id.hasPrefix("group:"), let title = section.title {
                    Section {
                        if !self.isGroupCollapsed(title) || !self.query
                            .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        {
                            self.rows(section.nodes)
                        }
                    } header: {
                        Button {
                            self.toggleGroupCollapsed(title)
                        } label: {
                            HStack {
                                Image(systemName: self.isGroupCollapsed(title) ? "chevron.right" : "chevron.down")
                                Text(verbatim: title)
                                    .font(OpenClawChatTypography.caption)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                } else if let title = section.title {
                    Section {
                        self.rows(section.nodes)
                    } header: {
                        Text(LocalizedStringKey(title))
                            .font(OpenClawChatTypography.caption)
                    }
                } else {
                    Section {
                        self.rows(section.nodes)
                    } header: {
                        Text("Recent")
                            .font(OpenClawChatTypography.caption)
                    }
                }
            }
            if sections.isEmpty {
                Text(self.query
                    .isEmpty ? String(localized: "No threads yet") : String(localized: "No matching threads"))
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 12)
                    .listRowSeparator(.hidden)
                    .selectionDisabled()
            }
        }
        .listStyle(.sidebar)
        .searchable(
            text: self.$query,
            placement: .sidebar,
            prompt: String(localized: "Search threads"))
        .safeAreaInset(edge: .bottom, spacing: 0) { self.connectionFooter }
        .task(id: self.groupRefreshID) {
            self.viewModel.refreshSessions(limit: 200)
            do {
                let groups = try await self.viewModel.fetchSessionGroups()
                self.groups = groups
                self.groupLoadFailed = false
            } catch {
                self.groupLoadFailed = true
            }
        }
        .onChange(of: self.viewModel.healthOK) { previous, current in
            if !previous, current {
                self.viewModel.refreshSessions(limit: 200)
            }
        }
        .sheet(item: self.$inspectedSession) { session in
            ChatSessionInspectorSheet(viewModel: self.viewModel, session: session)
        }
        .alert(
            String(localized: "Rename Thread"),
            isPresented: self.isPresentingRenameAlert)
        {
            TextField(String(localized: "Thread name"), text: self.$renameText)
            Button(String(localized: "Rename")) {
                if let session = self.sessionPendingRename {
                    self.viewModel.renameSession(key: session.key, label: self.renameText, agentID: session.agentId)
                }
                self.sessionPendingRename = nil
            }
            Button(String(localized: "Cancel"), role: .cancel) {
                self.sessionPendingRename = nil
            }
        }
        .confirmationDialog(self.deleteDialogTitle, isPresented: self.isPresentingDeleteDialog) {
                Button(String(localized: "Delete Thread"), role: .destructive) {
                    if let session = self.sessionPendingDeletion {
                        self.viewModel.deleteSession(session.key, agentID: session.agentId)
                    }
                    self.sessionPendingDeletion = nil
                }
            } message: {
                Text(String(localized: "The thread and its transcript are removed from the gateway."))
                    .font(OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .body))
            }
    }

    private var selectionBinding: Binding<String?> {
        Binding(
            get: {
                ChatSessionSidebarModel.selectedSessionKey(
                    sessions: self.viewModel.sessions,
                    currentSessionKey: self.viewModel.sessionKey,
                    mainSessionKey: self.viewModel.selectedAgentMainSessionKey,
                    activeAgentID: self.viewModel.selectedAgentID,
                    sessionRoutingContract: self.viewModel.agentCatalog?.sessionRoutingContract ??
                        self.viewModel.sessionRoutingContract)
            },
            set: { next in
                guard let next, next != self.viewModel.sessionKey else { return }
                let agentID = self.viewModel.sessions.first(where: { $0.key == next })?.agentId
                self.viewModel.switchSession(to: next, agentID: agentID)
            })
    }

    private var newThreadButton: some View {
        HStack(spacing: 0) {
            Button {
                Task { await self.viewModel.startNewSession() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "square.and.pencil")
                    Text("New Thread")
                    Spacer(minLength: 4)
                    Text(verbatim: "⌘N")
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.tertiary)
                }
                .padding(.leading, 12)
                .padding(.trailing, 8)
                .frame(height: 38)
                .contentShape(Rectangle())
            }
            .help(String(localized: "New thread"))
            .accessibilityIdentifier("chat-new-thread")
            Divider()
                .frame(height: 16)
            Button {
                self.isPresentingNewSessionOptions = true
            } label: {
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .frame(width: 30, height: 38)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel(String(localized: "New thread options"))
            .help(String(localized: "New thread options"))
            .popover(isPresented: self.$isPresentingNewSessionOptions) {
                ChatNewSessionOptionsPopover(viewModel: self.viewModel) {
                    self.isPresentingNewSessionOptions = false
                }
            }
        }
        .font(OpenClawChatTypography.body(size: 13, weight: .medium, relativeTo: .body))
        .buttonStyle(.plain)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(.primary.opacity(0.08), lineWidth: 1)
        }
        .disabled(self.viewModel.isCreatingSession)
    }

    private var agentsSection: some View {
        Section {
            ForEach(self.viewModel.agentChoices) { agent in
                self.agentRow(agent)
                    .selectionDisabled()
            }
            if let error = self.viewModel.agentsErrorText {
                VStack(alignment: .leading, spacing: 6) {
                    Text(error)
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                    Button("Retry") {
                        Task { await self.viewModel.refreshAgents() }
                    }
                    .disabled(self.viewModel.isLoadingAgents)
                }
                .selectionDisabled()
            } else if self.viewModel.isLoadingAgents, self.viewModel.agentChoices.isEmpty {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Loading agents…")
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                }
                .selectionDisabled()
            } else if self.viewModel.agentChoices.isEmpty {
                Text("No agents are available on this gateway.")
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(.secondary)
                    .selectionDisabled()
            }
        } header: {
            Text("Agents")
                .font(OpenClawChatTypography.caption)
        }
    }

    private func agentRow(_ agent: OpenClawChatAgentChoice) -> some View {
        let isSelected = agent.id.lowercased() == self.viewModel.selectedAgentID
        return Button {
            self.viewModel.switchAgent(to: agent.id)
        } label: {
            HStack(spacing: 10) {
                ChatSidebarAgentAvatar(agent: agent)
                Text(verbatim: agent.displayName)
                    .font(OpenClawChatTypography.body(
                        size: 13,
                        weight: isSelected ? .semibold : .regular,
                        relativeTo: .body))
                    .lineLimit(1)
                Spacer(minLength: 0)
                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("chat-agent-\(agent.id)")
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
        .help(String(format: String(localized: "Open %@"), agent.displayName))
    }

    private var groupRefreshID: String {
        let categories = self.viewModel.sessions.compactMap(\.category).sorted().joined(separator: "|")
        let revision = self.viewModel.sessionGroupsRevision
        return "\(self.viewModel.healthOK)|\(categories)|\(revision)|\(self.groupRefreshNonce)"
    }

    private var deleteDialogTitle: String {
        let name = self.sessionPendingDeletion.map(ChatSessionSidebarModel.displayName(for:)) ?? ""
        return String(format: String(localized: "Delete “%@”?"), name)
    }

    private var isPresentingDeleteDialog: Binding<Bool> {
        Binding(
            get: { self.sessionPendingDeletion != nil },
            set: { if !$0 { self.sessionPendingDeletion = nil } })
    }

    private var isPresentingRenameAlert: Binding<Bool> {
        Binding(
            get: { self.sessionPendingRename != nil },
            set: { if !$0 { self.sessionPendingRename = nil } })
    }

    private func rows(_ nodes: [ChatSessionSidebarModel.Node]) -> some View {
        OutlineGroup(nodes, children: \.outlineChildren) { node in
            self.row(for: node)
        }
    }

    private func row(for node: ChatSessionSidebarModel.Node) -> some View {
        let session = node.session
        return HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                Text(ChatSessionSidebarModel.displayName(for: session))
                    .font(OpenClawChatTypography.body(size: 13, weight: .medium, relativeTo: .body))
                    .lineLimit(1)
                if let subtitle = self.rowSubtitle(for: session) {
                    Text(subtitle)
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            self.badges(for: node)
        }
        .padding(.vertical, 4)
        .overlay(alignment: .leading) {
            OpenClawSessionColorStripe(color: session.color)
                .offset(x: -6)
        }
        // The tag type must equal the List selection type (String?) exactly.
        .tag(Optional(session.key))
        .contextMenu { self.contextMenu(for: session) }
    }

    @ViewBuilder
    private func badges(for node: ChatSessionSidebarModel.Node) -> some View {
        if node.badges.queuedCount > 0 {
            Image(systemName: "hourglass")
                .foregroundStyle(OpenClawChatTheme.warning)
                .accessibilityLabel(String(localized: "Thread queued"))
        }
        if node.badges.runningCount > 0 {
            ProgressView()
                .controlSize(.small)
                .accessibilityLabel(String(localized: "Thread running"))
        }
        if node.badges.failedCount > 0 {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(OpenClawChatTheme.warning)
                .accessibilityLabel(String(localized: "Thread failed"))
        }
        let isCurrentSession = self.viewModel.matchesCurrentSessionKey(
            incoming: node.session.key,
            current: self.viewModel.sessionKey)
        if node.children.contains(where: \.badges.hasUnread) ||
            (node.session.unread == true && !isCurrentSession)
        {
            Circle()
                .fill(.tint)
                .frame(width: 7, height: 7)
                .accessibilityLabel(String(localized: "Unread"))
        }
    }

    @ViewBuilder
    private func contextMenu(for session: OpenClawChatSessionEntry) -> some View {
        Button {
            self.inspectedSession = session
        } label: {
            self.actionLabel(String(localized: "Get Info…"), systemImage: "info.circle")
        }
        Divider()
        Button {
            self.renameText = session.label ?? session.displayName ?? ""
            self.sessionPendingRename = session
        } label: {
            self.actionLabel(String(localized: "Rename…"), systemImage: "pencil")
        }
        Button {
            self.viewModel.setSessionPinned(key: session.key, pinned: session.pinned != true, agentID: session.agentId)
        } label: {
            self.actionLabel(
                session.pinned == true ? String(localized: "Unpin") : String(localized: "Pin"),
                systemImage: session.pinned == true ? "pin.slash" : "pin")
        }
        Button {
            Task {
                await self.viewModel.forkSession(
                    key: session.key,
                    fromLastCompleted: session.hasActiveRun == true,
                    agentID: session.agentId)
            }
        } label: {
            self.actionLabel(
                session.hasActiveRun == true
                    ? String(localized: "Fork from last completed message")
                    : String(localized: "Fork"),
                systemImage: "arrow.triangle.branch")
        }
        Button {
            self.viewModel.setSessionUnread(key: session.key, unread: session.unread != true, agentID: session.agentId)
        } label: {
            self.actionLabel(
                session.unread == true ? String(localized: "Mark Read") : String(localized: "Mark Unread"),
                systemImage: session.unread == true ? "envelope.open" : "envelope.badge")
        }
        if ChatSessionSidebarModel.canArchiveSession(
            session,
            mainSessionKey: self.viewModel.selectedAgentMainSessionKey)
        {
            Button {
                self.viewModel.setSessionArchived(session, archived: !session.isArchived)
            } label: {
                self.actionLabel(
                    session.isArchived ? String(localized: "Restore") : String(localized: "Archive"),
                    systemImage: session.isArchived ? "tray.and.arrow.up" : "archivebox")
            }
        }
        OpenClawSessionColorMenu(color: session.color) { color in
            Task { await self.viewModel.setSessionColor(key: session.key, color: color, agentID: session.agentId) }
        }
        Divider()
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(session.key, forType: .string)
        } label: {
            self.actionLabel(String(localized: "Copy Session Key"), systemImage: "doc.on.doc")
        }
        if ChatSessionSidebarModel.canDeleteSession(
            key: session.key,
            mainSessionKey: self.viewModel.selectedAgentMainSessionKey)
        {
            Button(role: .destructive) {
                self.sessionPendingDeletion = session
            } label: {
                self.actionLabel(String(localized: "Delete Thread…"), systemImage: "trash")
            }
        }
    }

    private func isGroupCollapsed(_ name: String) -> Bool {
        Set(self.collapsedSessionGroups.split(separator: "\u{1F}").map(String.init)).contains(name)
    }

    private func toggleGroupCollapsed(_ name: String) {
        var names = Set(self.collapsedSessionGroups.split(separator: "\u{1F}").map(String.init))
        if !names.insert(name).inserted {
            names.remove(name)
        }
        self.collapsedSessionGroups = names.sorted().joined(separator: "\u{1F}")
    }

    private func actionLabel(_ title: String, systemImage: String) -> some View {
        Label(title, systemImage: systemImage)
            .font(OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .body))
    }

    private func rowSubtitle(for session: OpenClawChatSessionEntry) -> String? {
        var parts: [String] = []
        if let branch = session.worktree?.branch?.trimmingCharacters(in: .whitespacesAndNewlines),
           !branch.isEmpty
        {
            parts.append(branch)
        }
        if let updatedAt = session.updatedAt ?? session.lastActivityAt, updatedAt > 0 {
            let date = Date(timeIntervalSince1970: updatedAt / 1000)
            parts.append(date.formatted(.relative(presentation: .named)))
        }
        return ChatSessionSidebarModel.subtitle(
            for: session,
            workSubtitle: parts.isEmpty ? nil : parts.joined(separator: " · "))
    }

    private var connectionFooter: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(self.viewModel.healthOK ? .green : .orange)
                .frame(width: 7, height: 7)
            Text(self.viewModel.healthOK
                ? String(localized: "Gateway connected")
                : String(localized: "Connecting…"))
                .font(OpenClawChatTypography.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            if self.groupLoadFailed {
                Button {
                    self.groupRefreshNonce += 1
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help(String(localized: "Retry thread groups"))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 12)
        .background(.bar)
    }
}

struct ChatSidebarAgentAvatar: View {
    let agent: OpenClawChatAgentChoice
    var size: CGFloat = 28

    var body: some View {
        Text(self.avatarText)
            .font(.system(size: self.size * 0.5, weight: .medium))
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .frame(width: self.size, height: self.size)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: self.size * 0.3))
            .accessibilityHidden(true)
    }

    private var avatarText: String {
        if let emoji = self.agent.emoji?.trimmingCharacters(in: .whitespacesAndNewlines), !emoji.isEmpty {
            return String(emoji.prefix(1))
        }
        return String(self.agent.displayName.prefix(1)).uppercased()
    }
}
#endif
