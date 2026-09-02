import type {
  ArtifactId,
  ArtifactPolicyRef,
  AttemptId,
  AuditEventId,
  BrowserLeaseId,
  BrowserSessionId,
  ChallengeHandlerSetRef,
  CloneId,
  EgressPolicyRef,
  EventId,
  IdempotencyRecordId,
  InputRequestId,
  JobId,
  PrincipalId,
  ProfileRef,
  ProjectId,
  RecipeRef,
  VolumeGenerationId,
  WorkerId
} from "./ids";

export const runtimeFamilies = [
  "chromium-cdp",
  "patchright",
  "rebrowser-puppeteer",
  "playwright-social",
  "companion",
  "media-relay"
] as const;
export type RuntimeFamily = (typeof runtimeFamilies)[number];

export const leaseModes = ["writer", "interactive", "clone"] as const;
export type LeaseMode = (typeof leaseModes)[number];

export const browserSessionStatuses = [
  "queued",
  "allocating",
  "ready",
  "active",
  "releasing",
  "released",
  "cancelled",
  "failed",
  "timed_out"
] as const;
export type BrowserSessionStatus = (typeof browserSessionStatuses)[number];
export const terminalBrowserSessionStatuses = ["released", "cancelled", "failed", "timed_out"] as const;
export type TerminalBrowserSessionStatus = (typeof terminalBrowserSessionStatuses)[number];

export const jobStatuses = [
  "queued",
  "running",
  "awaiting_input",
  "awaiting_manual",
  "succeeded",
  "failed",
  "blocked_challenge",
  "auth_required",
  "timed_out",
  "cancelled"
] as const;
export type JobStatus = (typeof jobStatuses)[number];
export const terminalJobStatuses = [
  "succeeded",
  "failed",
  "blocked_challenge",
  "auth_required",
  "timed_out",
  "cancelled"
] as const;
export type TerminalJobStatus = (typeof terminalJobStatuses)[number];

export const workerHealthStates = ["healthy", "degraded", "offline", "draining"] as const;
export type WorkerHealthState = (typeof workerHealthStates)[number];

export const profileStatuses = ["active", "unhealthy", "relocating", "revoked"] as const;
export type ProfileStatus = (typeof profileStatuses)[number];

export const inputFieldTypes = ["password", "otp", "captcha_provider_credential", "proxy_credential", "form_value"] as const;
export type InputFieldType = (typeof inputFieldTypes)[number];

export const trafficClasses = [
  "document",
  "api",
  "websocket",
  "static_asset",
  "browser_download",
  "media_manifest",
  "media_key",
  "media_segment",
  "media_range",
  "provider_handshake",
  "captcha_solver",
  "direct_exception"
] as const;
export type TrafficClass = (typeof trafficClasses)[number];

export type EgressRoute =
  | { kind: "direct"; retryThroughProxy: boolean }
  | { kind: "proxy"; proxyRef: string; protocol: "http" | "https" | "socks4" | "socks5" | "socks5h"; remoteDns: boolean }
  | { kind: "tor"; poolRef: string; remoteDns: true }
  | { kind: "block"; reason: string };

export interface Principal {
  id: PrincipalId;
  displayName: string;
  projectGrants: readonly ProjectId[];
  roles: readonly ("project_admin" | "project_operator" | "project_reader" | "fabric_admin")[];
  certificateFingerprint: string;
  createdAt: string;
}

export interface Project {
  id: ProjectId;
  name: string;
  active: boolean;
  createdAt: string;
}

export interface WorkerResourceLimits {
  maxBrowserLeases: number;
  cpuMilli: number;
  memoryMiB: number;
  pids: number;
  shmMiB: number;
  temporaryStorageMiB: number;
}

export interface WorkerCapabilities {
  runtimeFamilies: readonly RuntimeFamily[];
  recipeRefs: readonly RecipeRef[];
  browserVersions: Readonly<Record<string, string>>;
  supportsInteractive: boolean;
  supportsCompanionCompanion: boolean;
  supportedProfileFamilies: readonly string[];
}

export interface Worker {
  id: WorkerId;
  certificateFingerprint: string;
  /** SHA-256 of a per-worker enrollment token; raw enrollment bytes are never durable. */
  enrollmentTokenHash?: string;
  /** Public key used for end-to-end encryption of ephemeral input envelopes. */
  inputEncryptionPublicKeyPem?: string;
  endpoint: string;
  cdpRelayEndpoint: string;
  capabilities: WorkerCapabilities;
  capacity: number;
  activeLeases: number;
  /** Media tasks do not consume browser leases but still have a bounded worker queue. */
  mediaCapacity?: number;
  activeMediaTasks?: number;
  health: WorkerHealthState;
  isLocal: boolean;
  volumeNames: readonly string[];
  resourceLimits: WorkerResourceLimits;
  lastHeartbeatAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserRecipe {
  ref: RecipeRef;
  family: string;
  version: number;
  runtime: RuntimeFamily;
  immutableHash: string;
  browserImage: string;
  browserVersion: string;
  mode: "headless" | "headful" | "interactive";
  profileFamily: string;
  requiredCapabilities: readonly string[];
  allowedCompanionConnections: readonly ("companion" | "file-input-bridge" | "none")[];
  launch: {
    viewport: { width: number; height: number };
    locale: string;
    timezone: string;
    userAgent?: string;
    launchFlags: readonly string[];
    extensions: readonly string[];
    initScripts: readonly string[];
    disableServiceWorkers?: boolean;
    sharedMemoryMiB: number;
    downloadsEnabled: boolean;
  };
  artifactDefaults: readonly ("screenshot" | "mhtml" | "trace" | "har" | "download")[];
  /** Access layer selected by the immutable recipe (raw CDP or typed operation). */
  access?: "raw_cdp" | "typed_job";
  challengeHandlerSetRef?: string;
  typedOperations?: readonly {
    name: string;
    requiredFields: readonly string[];
    allowedFields: readonly string[];
    secretInputFields: readonly string[];
  }[];
  maxAttempts?: number;
  createdAt: string;
}

export interface EgressPolicy {
  ref: EgressPolicyRef;
  family: string;
  version: number;
  immutableHash: string;
  routes: Readonly<Partial<Record<TrafficClass, EgressRoute>>>;
  /** Ordered proxy strategy preserved for runtimes such as SocialApi. */
  proxyFallbackRefs?: readonly string[];
  /** Hostname suffixes that are explicitly allowed to bypass proxy affinity. */
  directExceptionHostnames?: readonly string[];
  /** Optional provider-affinity key used to keep browser/media traffic on one egress identity. */
  affinityKey?: string;
  constraints: {
    preserveProxyAffinity: boolean;
    disableServiceWorkersInProxyMode: boolean;
    allowDirectMediaRelay: boolean;
  };
  createdAt: string;
}

export interface ChallengeHandlerSet {
  ref: ChallengeHandlerSetRef;
  family: string;
  version: number;
  immutableHash: string;
  handlers: readonly ChallengeHandler[];
  createdAt: string;
}

export interface ChallengeHandler {
  id: string;
  kind: "cloudflare" | "dbc" | "anticaptcha" | "turnstile-click-loop" | "interactive-turnstile" | "manual-handoff" | "social-fallback";
  mode: "automatic" | "manual" | "fallback";
  configuration: Readonly<Record<string, string | number | boolean>>;
}

export interface ArtifactPolicy {
  ref: ArtifactPolicyRef;
  retentionDays: number;
  allowedKinds: readonly ("screenshot" | "mhtml" | "trace" | "har" | "download" | "video" | "log")[];
  createdAt: string;
}

export interface ProfileGrant {
  profileRef: ProfileRef;
  project: ProjectId;
  grantedBy: PrincipalId;
  createdAt: string;
}

export interface Profile {
  ref: ProfileRef;
  ownerProject: ProjectId;
  grants: readonly ProjectId[];
  workerId: WorkerId;
  volumeName: string;
  profileFamily: string;
  volumeGeneration: number;
  status: ProfileStatus;
  lastHealthCheckAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VolumeGeneration {
  id: VolumeGenerationId;
  profileRef: ProfileRef;
  generation: number;
  workerId: WorkerId;
  volumeName: string;
  status: "active" | "relocating" | "retired";
  checksum?: string;
  createdAt: string;
}

export interface BrowserSessionCreateInput {
  project: ProjectId;
  idempotencyKey: string;
  runtime: RuntimeFamily;
  browserRecipeRef: RecipeRef;
  profileRef?: ProfileRef;
  leaseMode: LeaseMode;
  egressPolicyRef: EgressPolicyRef;
  artifactPolicyRef: ArtifactPolicyRef;
  metadata?: Record<string, string | number | boolean | null>;
  ttlSeconds: number;
}

export interface BrowserSession {
  id: BrowserSessionId;
  project: ProjectId;
  idempotencyKey: string;
  runtime: RuntimeFamily;
  browserRecipeRef: RecipeRef;
  profileRef?: ProfileRef;
  leaseMode: LeaseMode;
  egressPolicyRef: EgressPolicyRef;
  artifactPolicyRef: ArtifactPolicyRef;
  metadata: Record<string, string | number | boolean | null>;
  status: BrowserSessionStatus;
  /** Monotonic queue insertion sequence used for exact FIFO ordering when timestamps tie. */
  queueSequence?: number;
  workerId?: WorkerId;
  leaseId?: BrowserLeaseId;
  cdpEndpoint?: string;
  cdpInternalEndpoint?: string;
  cdpCapabilityExpiresAt?: string;
  externalConnectionCount: number;
  reconnectGraceUntil?: string;
  expiresAt: string;
  lastHeartbeatAt: string;
  createdAt: string;
  updatedAt: string;
  releasedAt?: string;
  failureReason?: string;
}

export interface BrowserLease {
  id: BrowserLeaseId;
  sessionId?: BrowserSessionId;
  jobId?: JobId;
  project: ProjectId;
  profileRef?: ProfileRef;
  workerId: WorkerId;
  /** Worker-only endpoint; never included in public session/job responses. */
  internalCdpEndpoint?: string;
  /** Disposable volume for a session that intentionally did not request a durable profile. */
  ephemeralVolumeName?: string;
  mode: LeaseMode;
  cloneId?: CloneId;
  status: "active" | "releasing" | "released" | "lost";
  expiresAt: string;
  lastHeartbeatAt: string;
  createdAt: string;
  assignmentClaimedAt?: string;
  startedAt?: string;
  releasedAt?: string;
}

export interface ProfileClone {
  id: CloneId;
  sourceProfileRef: ProfileRef;
  workerId: WorkerId;
  volumeName: string;
  createdForLease: BrowserLeaseId;
  status: "creating" | "ready" | "destroying" | "destroyed";
  createdAt: string;
  deletedAt?: string;
}

export interface JobCreateInput {
  project: ProjectId;
  idempotencyKey: string;
  recipeRef: RecipeRef;
  operation: Record<string, unknown>;
  profileRef?: ProfileRef;
  leaseMode?: LeaseMode;
  egressPolicyRef: EgressPolicyRef;
  artifactPolicyRef: ArtifactPolicyRef;
  callback?: { url: string; eventSecretRef?: string };
  ttlSeconds?: number;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface Job {
  id: JobId;
  project: ProjectId;
  idempotencyKey: string;
  recipeRef: RecipeRef;
  runtime: RuntimeFamily;
  operation: Record<string, unknown>;
  profileRef?: ProfileRef;
  leaseMode: LeaseMode;
  egressPolicyRef: EgressPolicyRef;
  artifactPolicyRef: ArtifactPolicyRef;
  callback?: { url: string; eventSecretRef?: string };
  metadata: Record<string, string | number | boolean | null>;
  status: JobStatus;
  /** Monotonic queue insertion sequence used for exact FIFO ordering when timestamps tie. */
  queueSequence?: number;
  workerId?: WorkerId;
  leaseId?: BrowserLeaseId;
  result?: Record<string, unknown>;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  assignmentClaimedAt?: string;
  mediaTaskActive?: boolean;
}

export interface JobAttempt {
  id: AttemptId;
  jobId: JobId;
  number: number;
  workerId?: WorkerId;
  leaseId?: BrowserLeaseId;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  createdAt: string;
  completedAt?: string;
}

export interface FabricEvent {
  id: EventId;
  sequence: number;
  project?: ProjectId;
  subject: { kind: "browser_session" | "job" | "profile" | "worker"; id: string };
  type: string;
  payload: Record<string, string | number | boolean | null>;
  createdAt: string;
}

export interface Artifact {
  id: ArtifactId;
  project: ProjectId;
  sessionId?: BrowserSessionId;
  jobId?: JobId;
  profileRef?: ProfileRef;
  kind: "screenshot" | "mhtml" | "trace" | "har" | "download" | "video" | "log";
  objectKey: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string;
}

export interface EphemeralInputRequest {
  id: InputRequestId;
  project: ProjectId;
  sessionId?: BrowserSessionId;
  jobId?: JobId;
  leaseId: BrowserLeaseId;
  workerId?: WorkerId;
  /** Public key is safe to return to the application; the corresponding private key stays on the worker. */
  workerInputEncryptionPublicKeyPem?: string;
  field: string;
  fieldType: InputFieldType;
  status: "pending" | "supplied" | "consumed" | "expired" | "cancelled";
  expiresAt: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface IdempotencyRecord {
  id: IdempotencyRecordId;
  project: ProjectId;
  scope: "browser_session" | "job";
  key: string;
  requestHash: string;
  responseId: BrowserSessionId | JobId;
  createdAt: string;
}

export interface AuditEvent {
  id: AuditEventId;
  actor: PrincipalId;
  project?: ProjectId;
  action: string;
  target: { kind: string; id: string };
  outcome: "allowed" | "denied" | "succeeded" | "failed";
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
}

export interface BrowserSessionResponse {
  id: BrowserSessionId;
  status: BrowserSessionStatus;
  cdpEndpoint?: string;
  expiresAt: string;
  workerId?: WorkerId;
  profileLease?: { id: BrowserLeaseId; mode: LeaseMode; profileRef?: ProfileRef };
}

export interface JobResponse {
  id: JobId;
  status: JobStatus;
  expiresAt: string;
  workerId?: WorkerId;
  result?: Record<string, unknown>;
}

export interface CdpCapabilityClaims {
  version: 1;
  sessionId: BrowserSessionId;
  project: ProjectId;
  profileRef?: ProfileRef;
  workerId: WorkerId;
  expiresAt: number;
  nonce: string;
}

export interface WorkerAssignment {
  /** Media-only recipes deliberately have no BrowserLease. */
  lease?: BrowserLease;
  session?: BrowserSession;
  job?: Job;
  recipe: BrowserRecipe;
  egressPolicy: EgressPolicy;
  artifactPolicy: ArtifactPolicy;
  profile?: Profile;
  clone?: ProfileClone;
}
