export const FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: "1";
export type ValidationPurpose =
  | "publish"
  | "diagnostic"
  | "main-qualification"
  | "postpublish-confidence";
export interface PublicationSelection {
  route: "normal" | "prepared" | "extended-stable" | "alpha";
  npmDistTag: "alpha" | "beta" | "latest" | "extended-stable";
  publishOpenclawNpm: boolean;
  pluginPublishScope: "selected" | "all-publishable";
  plugins: string[];
  windowsNodeTag?: string;
  windowsNodeInstallerDigests?: Record<string, string>;
}
export interface PublicationIntent {
  validationPurpose: ValidationPurpose;
  publicationSelection: PublicationSelection | null;
}
export interface PublicationDispatchEnvelope extends PublicationIntent {
  trustedWorkflow: { ref: string; fullRef: string; sha: string } | null;
}
export interface PublicationSourceRequest extends PublicationIntent {
  repository: string;
  candidateSha: string;
  targetContextRef: string;
  tooling: { ref: string; sha: string };
  workflow: { ref: string; sha: string };
  runId: string;
  runAttempt: number;
  coverage: Record<string, string>;
}
export interface PublicationSourceFact extends PublicationSourceRequest {
  kind: "openclaw.full-release-source-admission/v1";
  contract: "1";
  status: "source-admitted" | "not-applicable";
  inventoryDigest: string | null;
  projection: { version: string; packages: unknown[]; platforms: unknown[] } | null;
  digest: string;
}
export function publicationSourceContract(source: string): "1" | undefined;
export function publicationSourceJson(value: unknown): string;
export function normalizePublicationIntent(
  purpose: unknown,
  selectionJson?: unknown,
): PublicationIntent;
export function publicationIntentInputs(intent: PublicationIntent): {
  validationPurpose: ValidationPurpose;
  publicationSelectionJson: string;
};
export function decodePublicationDispatchEnvelope(raw: unknown): PublicationDispatchEnvelope;
export function publicationDispatchEnvelope(
  trustedWorkflow: PublicationDispatchEnvelope["trustedWorkflow"],
  intent: PublicationIntent,
): string;
export function publicationSourceRequest(
  env: Record<string, string | undefined>,
): PublicationSourceRequest;
export function createPublicationSourceFact(
  request: PublicationSourceRequest,
  inventory: unknown,
  projection: PublicationSourceFact["projection"],
): PublicationSourceFact;
export function validatePublicationSourceBinding(
  record: Record<string, unknown>,
  expected?: Record<string, unknown>,
): PublicationSourceFact | undefined;
export function publicationSourceReuseIdentity(
  fact: PublicationSourceFact | undefined,
):
  | Pick<
      PublicationSourceFact,
      "validationPurpose" | "publicationSelection" | "inventoryDigest" | "projection"
    >
  | undefined;
