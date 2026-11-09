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
  "media-relay",
  /** Persistent, capability-gated HLS/MP4 playback relay. It never creates a browser lease. */
  "media-playback"
] as const;
export type RuntimeFamily = (typeof runtimeFamilies)[number];
export type MediaRuntimeFamily = "media-relay" | "media-playback";

/** Media workers consume bounded media capacity independently from browser leases. */
export function isMediaRuntime(value: string): value is MediaRuntimeFamily {
  return value === "media-relay" || value === "media-playback";
}

export const leaseModes = ["writer", "interactive", "clone"] as const;

/**
 * Simultaneous external CDP clients one session may allow. Chromium serves many DevTools clients
 * natively and every client already holds the session's full raw-CDP authority, so this bounds
 * resources rather than privilege: an agent shares one browser between an MCP, scripts, a live
 * view and its keep-alive connection. Sessions default to one.
 */
export const MAX_EXTERNAL_CDP_CONNECTIONS = 8;

/**
 * Upper bound for a deployment's concurrent browser leases (`FABRIC_MAX_ACTIVE_BROWSER_LEASES`),
 * enforced by the scheduler and by the `fabric_capacity` CHECK. A deployment picks its own cap
 * within it; without one the scheduler uses DEFAULT_ACTIVE_BROWSER_LEASES.
 */
export const MAX_ACTIVE_BROWSER_LEASES = 8;
export const DEFAULT_ACTIVE_BROWSER_LEASES = 4;
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

export const inputFieldTypes = ["password", "otp", "captcha_provider_credential", "proxy_credential", "form_value", "media_playback_source"] as const;
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

/**
 * `GET /v1/me`: what the calling principal may use, so a client can choose valid project,
 * profile, recipe and policy refs without reading deployment files.
 */
export interface PrincipalCapabilities {
  principal: PrincipalId;
  roles: Principal["roles"];
  projects: { id: ProjectId; name: string }[];
  profiles: { ref: ProfileRef; ownerProject: ProjectId; grants: ProjectId[]; profileFamily: string; status: ProfileStatus }[];
  /** Recipes at least one registered worker serves. `raw_cdp` recipes back browser sessions; the rest run typed jobs. */
  recipes: { ref: RecipeRef; runtime: RuntimeFamily; mode: BrowserRecipe["mode"]; access: "raw_cdp" | "typed_job"; profileFamily: string }[];
  egressPolicies: EgressPolicyRef[];
  artifactPolicies: ArtifactPolicyRef[];
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
  /** Private HTTP origin of a persistent capability-gated media playback worker, when supported. */
  mediaPlaybackEndpoint?: string;
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
  kind: "cloudflare" | "dbc" | "anticaptcha" | "interactive-turnstile" | "manual-handoff" | "social-fallback";
  mode: "automatic" | "manual" | "fallback";
  configuration: Readonly<Record<string, string | number | boolean>>;
}

export interface ArtifactPolicy {
  ref: ArtifactPolicyRef;
  retentionDays: number;
  allowedKinds: readonly ("screenshot" | "mhtml" | "trace" | "har" | "download" | "video" | "log" | "media_manifest")[];
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
  /** Maximum simultaneous external CDP clients for this session, 1 to MAX_EXTERNAL_CDP_CONNECTIONS. Defaults to one. */
  maxExternalConnections?: number;
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
  maxExternalConnections?: number;
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
  /** Non-secret companion execution id (for example Companion's run id). */
  companionRunId?: string;
  /** Reserved once for a one-shot media output so immutable retries keep the same object metadata. */
  mediaArtifactExpiresAt?: string;
  /** Active media-only attempt that authorizes exactly one result capability. */
  mediaAttemptId?: AttemptId;
  /**
   * Non-secret identity of the exact encrypted source request that the active playback relay must
   * consume before it can be marked ready. This prevents an older consumed source from satisfying
   * a later provider-refresh request on the same attempt.
   */
  mediaPlaybackSourceRequestId?: InputRequestId;
  /**
   * Set only after an assigned encrypted playback-source worker has bound its private relay.
   * The provider URL, cookies, and public playback capability deliberately never enter this row.
   */
  mediaPlaybackReadyAt?: string;
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
  subject: { kind: "browser_session" | "job" | "profile" | "worker" | "artifact"; id: string };
  type: string;
  payload: Record<string, string | number | boolean | null>;
  createdAt: string;
}

export interface Artifact {
  id: ArtifactId;
  project: ProjectId;
  /** Browser/job outputs have exactly one owner. A media_manifest is intentionally project-scoped
   * so an application can submit it before the media job that will consume it exists. */
  sessionId?: BrowserSessionId;
  jobId?: JobId;
  profileRef?: ProfileRef;
  kind: "screenshot" | "mhtml" | "trace" | "har" | "download" | "video" | "log" | "media_manifest";
  objectKey: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string;
}

/**
 * Artifact data that may cross the public API boundary. Object keys are internal storage routing
 * details: applications receive a bounded signed read URL through ArtifactAccess instead.
 */
export interface ArtifactResponse {
  id: ArtifactId;
  project: ProjectId;
  sessionId?: BrowserSessionId;
  jobId?: JobId;
  profileRef?: ProfileRef;
  kind: Artifact["kind"];
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string;
}

export function publicArtifact(artifact: Artifact): ArtifactResponse {
  return {
    id: artifact.id,
    project: artifact.project,
    ...(artifact.sessionId === undefined ? {} : { sessionId: artifact.sessionId }),
    ...(artifact.jobId === undefined ? {} : { jobId: artifact.jobId }),
    ...(artifact.profileRef === undefined ? {} : { profileRef: artifact.profileRef }),
    kind: artifact.kind,
    sha256: artifact.sha256,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    createdAt: artifact.createdAt,
    expiresAt: artifact.expiresAt,
  };
}

export interface EphemeralInputRequest {
  id: InputRequestId;
  project: ProjectId;
  sessionId?: BrowserSessionId;
  jobId?: JobId;
  /** Browser/session work uses a lease; media playback source handoffs bind to an attempt instead. */
  leaseId?: BrowserLeaseId;
  mediaAttemptId?: AttemptId;
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
  failureReason?: string;
}

export interface JobResponse {
  id: JobId;
  status: JobStatus;
  expiresAt: string;
  workerId?: WorkerId;
  result?: Record<string, unknown>;
  failureReason?: string;
}

/** A short-lived bearer endpoint for an active Fabric-owned media playback relay. */
export interface MediaPlaybackEndpoint {
  endpoint: string;
  expiresAt: string;
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
  /**
   * The recipe's resolved challenge handler set, copied into the signed assignment so a worker decides
   * which automatic handlers it may run (for example token solving) without any side lookup.
   */
  challengeHandlerSet?: ChallengeHandlerSet;
  egressPolicy: EgressPolicy;
  artifactPolicy: ArtifactPolicy;
  profile?: Profile;
  clone?: ProfileClone;
}
