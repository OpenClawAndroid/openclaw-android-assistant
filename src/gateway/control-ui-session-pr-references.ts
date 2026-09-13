import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { searchSessionTranscripts } from "../config/sessions/session-transcript-search.js";
import { readAssistantDisplayContent } from "../shared/assistant-display-content.js";
import { readSessionMessageByIdAsync } from "./session-transcript-readers.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";

const GITHUB_URL_CANDIDATE = /https:\/\/github\.com\/[^\s<>()\]}'"`]+/giu;
const MAX_REFERENCES = 3;

function referencedPullRequestNumber(
  href: string,
  repository: { owner: string; repo: string },
): number | undefined {
  try {
    const url = new URL(href.replace(/[.,;:!?]+$/u, ""));
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.username ||
      url.password ||
      url.port
    ) {
      return undefined;
    }
    const [, owner, repo, kind, number] = url.pathname.split("/");
    if (
      !owner ||
      !repo ||
      kind !== "pull" ||
      !number ||
      !/^[1-9]\d{0,9}$/u.test(number) ||
      decodeURIComponent(owner).toLowerCase() !== repository.owner.toLowerCase() ||
      decodeURIComponent(repo).toLowerCase() !== repository.repo.toLowerCase()
    ) {
      return undefined;
    }
    return Number(number);
  } catch {
    return undefined;
  }
}

/** References describe this conversation's work; they never grant publication authority. */
export async function loadSessionPullRequestReferences(
  params: { sessionKey: string; agentId?: string },
  repository: { owner: string; repo: string },
): Promise<number[]> {
  const loaded = loadGatewaySessionEntryReadOnly(params.sessionKey, { agentId: params.agentId });
  const { entry, agentId, canonicalKey, storePath } = loaded;
  if (!entry?.sessionId || !storePath) {
    return [];
  }
  const scope = { agentId, sessionId: entry.sessionId, sessionKey: canonicalKey, storePath };
  const candidates = searchSessionTranscripts({
    ...scope,
    sessionKeys: [canonicalKey],
    role: "assistant",
    query: `https://github.com/${repository.owner}/${repository.repo}/pull`,
    order: "recent",
    limit: 25,
  });
  if (candidates.indexing && candidates.hits.length === 0) {
    throw new Error("Session pull request references are waiting for transcript indexing");
  }
  const references = new Set<number>();
  let remainingBytes = 128 * 1024;
  // Search skips bulky tool output; canonical hydration rejects reset-hidden hits.
  for (const candidate of candidates.hits) {
    if (remainingBytes <= 0 || references.size === MAX_REFERENCES) {
      break;
    }
    const result = await readSessionMessageByIdAsync(scope, candidate.messageId, {
      currentOnly: true,
      maxBytes: remainingBytes,
    });
    remainingBytes -= result.serializedBytes ?? 0;
    const record = asOptionalRecord(result.message);
    if (record?.role !== "assistant") {
      continue;
    }
    const blocks = readAssistantDisplayContent(record);
    const texts =
      !Array.isArray(record.openclawDisplayContent) && typeof record.content === "string"
        ? [record.content]
        : blocks.flatMap((block) =>
            block.type === "text" && typeof block.text === "string" ? [block.text] : [],
          );
    for (const text of texts.toReversed()) {
      for (const match of Array.from(text.matchAll(GITHUB_URL_CANDIDATE)).toReversed()) {
        const number = referencedPullRequestNumber(match[0], repository);
        if (number !== undefined && references.size < MAX_REFERENCES) {
          references.add(number);
        }
      }
    }
  }
  const current = loadGatewaySessionEntryReadOnly(params.sessionKey, { agentId: params.agentId });
  if (
    current.agentId !== agentId ||
    current.canonicalKey !== canonicalKey ||
    current.storePath !== storePath ||
    current.entry?.sessionId !== entry.sessionId ||
    current.entry.lifecycleRevision !== entry.lifecycleRevision ||
    current.entry.repositoryWorkspaceId !== entry.repositoryWorkspaceId ||
    current.entry.worktree?.id !== entry.worktree?.id ||
    current.entry.worktree?.branch !== entry.worktree?.branch ||
    current.entry.spawnedCwd !== entry.spawnedCwd ||
    current.entry.spawnedWorkspaceDir !== entry.spawnedWorkspaceDir
  ) {
    return [];
  }
  return [...references];
}
