/**
 * V2 schema types — Phase 1 `schema-v2` minimal foundation.
 *
 * These are the JSON-safe data contracts of
 * `NEXT-GENERATION-ARCHITECTURE.md` §3: everything a Domain Pack may carry,
 * with **no functions and no runtime behavior**. Provider manifests are
 * JSON-safe declarations (capabilities, transports, auth *descriptors*)
 * consumed by the `provider-runtime` module — registry, capability
 * resolution and envelope normalization; quality policies are gate-binding
 * declarations consumed by the `compiler` and `quality` modules (fixed
 * chain, hard-fail block, ≤2-round repair). Nothing here is wired into the
 * Host registration or the UI yet.
 *
 * Conventions:
 * - `schemaVersion` is fixed at 2 on every pack and pack-level object
 *   where present; a persisted document without it is not V2.
 * - Every top-level entity is versioned (`version`, semver-recommended) so
 *   overlays and provenance can reference exact versions.
 * - Unknowable values are never fabricated: adapters mark the whole object
 *   with `legacySource` rather than inventing initials, proficiencies or
 *   capabilities.
 * @module dsh-expert-library/v2/types
 */

/** Schema version of every V2 document. Fixed; do not bump per-pack. */
export const SCHEMA_VERSION = 2 as const

/**
 * Identifier safe as a registry key and a single path segment.
 * Same rule as {@link isSafeKnowledgeId}: unicode letters/digits first,
 * `._-` inside, ≤64 chars — no separators, no `..`, no whitespace.
 */
export type SafeId = string

/** Semantic-version-shaped string; loose (non-semver triggers a warning, not an error). */
export type VersionString = string

/** Where an object came from; set when a V1 structure was adapted. */
export type LegacySource = 'v1'

/** Proficiency is a closed 1..5 scale (5 = domain-leading). */
export type Proficiency = 1 | 2 | 3 | 4 | 5

/** How well the expert's knowledge covers a capability area. */
export type Coverage = 'high' | 'medium' | 'low'

/** One capability an expert claims, with conservatively-filled metadata. */
export interface CapabilityClaim {
  /** Dotted capability id (e.g. `market.timeseries`). */
  readonly capability: string
  /** Self/roster-assessed proficiency; 1 means "unassessed floor" when legacy. */
  readonly proficiency: Proficiency
  /** Knowledge coverage for routing-score weighting. */
  readonly coverage: Coverage
  /** Where the claim comes from (roster file, evidence doc, `legacy:v1`). */
  readonly evidenceRefs?: readonly string[]
  /** ISO date the claim started being valid. */
  readonly validFrom?: string
  /** ISO date the claim stopped being valid (stale expertise). */
  readonly validTo?: string
  /** Set when this claim was inferred by the V1 adapter, not asserted by data. */
  readonly legacySource?: LegacySource
}

/** Named mental model with the context that makes it applicable. */
export interface MentalModel {
  readonly name: string
  readonly summary: string
  readonly evidence?: readonly string[]
  readonly applicationContext?: string
  readonly failureCondition?: string
}

/** JSON-safe persona: how an expert thinks and speaks. No prompt strings here. */
export interface PersonaProfile {
  /** Writing/speaking style rules (references to style policies preferred). */
  readonly style?: readonly string[]
  readonly tone?: string
  /** Stated cognitive biases (self-declared blind spots). */
  readonly bias?: readonly string[]
  readonly mentalModels?: readonly MentalModel[]
  readonly blindSpots?: {
    readonly knownBias?: string
    readonly weakDomains?: readonly string[]
    readonly selfAwareness?: string
  }
  /** Signature phrases; injected only into internal rendering. */
  readonly signaturePhrases?: readonly string[]
  /** Anti-patterns this expert must not produce. */
  readonly antiPatterns?: readonly string[]
  /** Set when the persona was lifted verbatim from a V1 Expert. */
  readonly legacySource?: LegacySource
}

/** Reference to an analysis method (steps/lenses live in method libraries). */
export interface MethodRef {
  /** Method library entry id (e.g. `method.framework-d-fusion`). */
  readonly id: string
  /** Version of the referenced method definition. */
  readonly version?: VersionString
  readonly legacySource?: LegacySource
}

/** Binding of an expert to a knowledge provider scope. */
export interface KnowledgeBinding {
  /** Knowledge provider manifest id. */
  readonly providerId: string
  /** Scope inside the provider (folder, entity type, collection…). */
  readonly scope?: string
  readonly legacySource?: LegacySource
}

/** Preset model route; same semantics as the V1 ExpertModelRoute. */
export interface ModelPolicy {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Compliance flags consulted by the Compliance/Anonymization gate. */
export interface ComplianceInfo {
  /** Deceased experts may only be cited for historical views. */
  readonly deceased?: boolean
  /** Internal-only experts must not appear in external deliverables. */
  readonly internalOnly?: boolean
  /** Free-form citation policy (e.g. "克而瑞口径"). */
  readonly citationPolicy?: string
}

/** Anonymization double track: internal identity vs public label. */
export interface ExpertDisplay {
  /** Internal, full identity (shown only in permissioned views). */
  readonly internalName: string
  /** External label (e.g. `宏观周期派 X 博士`); never the real name. */
  readonly publicLabel: string
  /** Anonymous initials used in external annotations. */
  readonly initials: string
}

/** V2 expert: identity separated from scenario roles. */
export interface ExpertV2 {
  readonly id: SafeId
  readonly version: VersionString
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly display: ExpertDisplay
  /** Domains this expert belongs to (pack-defined vocabulary). */
  readonly domains: readonly string[]
  /** Must be non-empty; validated 1..5 proficiency per claim. */
  readonly capabilities: readonly CapabilityClaim[]
  readonly persona: PersonaProfile
  readonly methods: readonly MethodRef[]
  readonly knowledgeBindings: readonly KnowledgeBinding[]
  /** Capability ids (not tool names) this expert works well with. */
  readonly toolAffinities: readonly string[]
  readonly modelPolicy?: ModelPolicy
  readonly compliance: ComplianceInfo
  /** Set when adapted from V1: consumers must treat fields conservatively. */
  readonly legacySource?: LegacySource
}

/** One capability served by a tool provider, with I/O contract and caliber. */
export interface ToolCapability {
  /** Dotted capability id (e.g. `realestate.indicators.timeseries`). */
  readonly capability: string
  /** Operation id inside the provider (e.g. `zyt.indicators.series`). */
  readonly operation: string
  /** Transport id inside the same provider that executes this operation. */
  readonly transportId?: string
  /** JSON Schema of the request, or a reference (`$ref`-style string). */
  readonly inputSchema?: Record<string, unknown> | string
  /** JSON Schema of the response payload, or a reference. */
  readonly outputSchema?: Record<string, unknown> | string
  /** Data caliber notes the Data gate must enforce (e.g. "external=指数化"). */
  readonly caliber?: string
  /** Freshness guarantee of returned data. */
  readonly freshness?: 'realtime' | 'daily' | 'monthly' | 'static'
}

/**
 * Common fields of every tool transport. Transports describe *how* an
 * operation reaches its backend — unlike skills (local-only), tool
 * transports may legitimately be remote (MCP/HTTP) or local (CLI/stdio).
 */
export interface ToolTransportBase {
  /** Transport id, unique inside the provider; capabilities bind to it. */
  readonly id: string
  /** Per-call timeout in milliseconds. */
  readonly timeoutMs?: number
  /** Whether calls through this transport default to read-only (writes need approval). */
  readonly readOnly?: boolean
  /** Credential reference for this transport; never a secret. */
  readonly auth?: AuthDescriptor
}

/** Local MCP server over stdio (e.g. `beike mcp` in stdio mode). */
export interface McpStdioTransport extends ToolTransportBase {
  readonly kind: 'mcp-stdio'
  /** Executable command to launch the MCP server. */
  readonly command: string
  /** Launch arguments. */
  readonly args?: readonly string[]
}

/** Remote or local MCP server over streamable HTTP (e.g. `building.ke.com/mcp`). */
export interface McpHttpTransport extends ToolTransportBase {
  readonly kind: 'mcp-http'
  /** MCP endpoint URL. */
  readonly endpoint: string
}

/** Plain HTTP API backend (e.g. zyt `/openapi/v1/*`). */
export interface HttpApiTransport extends ToolTransportBase {
  readonly kind: 'http-api'
  /** Base URL every operation path is resolved against. */
  readonly baseUrl: string
}

/** Controlled local CLI invocation (e.g. `node cli.mjs call ...`). */
export interface LocalCliTransport extends ToolTransportBase {
  readonly kind: 'local-cli'
  /** Executable command. */
  readonly command: string
  /** Working directory for the command. */
  readonly workingDirectory?: string
}

/** The closed union of tool transports a provider may declare. */
export type ToolTransport = McpStdioTransport | McpHttpTransport | HttpApiTransport | LocalCliTransport

/** Points at the credential layer; never contains a secret. */
export interface AuthDescriptor {
  /** Credential kind/key name resolved by the host (e.g. `BEIKE_MCP_API_KEY`). */
  readonly credentialRef: string
  /** Where the credential is read from (env/file/credential-service). */
  readonly source?: 'env' | 'file' | 'credential-service' | 'inline-flag'
  /** Path/name hint for humans; no secret material. */
  readonly hint?: string
}

/** Dynamic schema discovery (e.g. Wind `list-tools` returning inputSchema). */
export interface DiscoveryDescriptor {
  /** Capability exposing the provider's own schema catalog. */
  readonly operation: string
  /** How often the cached catalog should be refreshed. */
  readonly refresh?: 'always' | 'daily' | 'manual'
}

/**
 * Serializable description of a Tool Provider (§3.2 without `invoke`).
 * The envelope contract (`ok/data/provenance/warnings/error`) is a runtime
 * concern; manifests only declare what the provider can do and how its
 * operations are reached (transports — remote allowed, credentials by
 * reference only).
 */
export interface ToolProviderManifest {
  readonly id: SafeId
  readonly version: VersionString
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly capabilities: readonly ToolCapability[]
  /** Non-empty; every capability's transportId must resolve here. */
  readonly transports: readonly ToolTransport[]
  readonly discovery?: DiscoveryDescriptor
  /** Known operational caveats surfaced to resolvers (e.g. "market-snapshot 联调 500"). */
  readonly caveats?: readonly string[]
}

/** Serializable description of a Knowledge Provider (§3.3 without `query`). */
export interface KnowledgeProviderManifest {
  readonly id: SafeId
  readonly version: VersionString
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly kind: 'files' | 'structured-wiki' | 'search-index' | 'database' | 'stream'
  readonly capabilities: readonly ('search' | 'read' | 'cite' | 'history' | 'write' | 'validate')[]
  readonly freshness: 'static' | 'monthly' | 'daily' | 'realtime'
  /** Scopes this provider serves (folder roots, entity namespaces…). */
  readonly scopes?: readonly string[]
  /** Domain knowledge bases this provider serves; resolved inside the pack. */
  readonly domainKnowledgeIds?: readonly string[]
}

/** One record collection of a domain knowledge base (documents/sources). */
export interface KnowledgeCollection {
  readonly id: SafeId
  /** Local root of the collection, relative to the knowledge base root. */
  readonly root: string
  /** Content shape hint for readers/indexers (e.g. `markdown`, `jsonl`). */
  readonly format?: string
  /** What the collection holds, for humans and retrieval routing. */
  readonly description?: string
}

/** How records may be retrieved from a domain knowledge base. */
export interface RetrievalProfile {
  readonly id: SafeId
  readonly method: 'keyword' | 'semantic' | 'graph' | 'full-read'
  /** Profile-specific tuning (analyzer, top-k, graph depth…). */
  readonly config?: Record<string, unknown>
}

/** Usage policies a domain knowledge base enforces. */
export interface DomainKnowledgePolicy {
  /** Whether every number/statement drawn from the base must be cited. */
  readonly citation: 'required' | 'optional'
  /** Expected refresh cadence of the snapshots. */
  readonly freshness: 'static' | 'monthly' | 'daily' | 'realtime'
  /** `readonly` forbids member writes; `append` allows additive contributions. */
  readonly access: 'readonly' | 'append'
}

/**
 * A structured domain knowledge base (§3.3): boundary + ontology +
 * collections + snapshot + retrieval + policies. Unlike a plain knowledge
 * folder, the manifest makes the domain boundary, record provenance and
 * access semantics machine-checkable, so gates can verify citations and
 * freshness, and experts bind to scopes without copying content.
 */
export interface DomainKnowledgeManifest {
  readonly id: SafeId
  readonly version: VersionString
  readonly schemaVersion: typeof SCHEMA_VERSION
  /** Domain id this base covers (e.g. `realestate.research`). */
  readonly domain: string
  /** What belongs inside this base — the boundary assertions. */
  readonly boundary: string
  /** Controlled vocabulary: entity types and relations of the domain. */
  readonly ontology: {
    readonly entities: ReadonlyArray<{ readonly id: string; readonly description: string }>
    readonly relations?: ReadonlyArray<{ readonly id: string; readonly from: string; readonly to: string; readonly description?: string }>
  }
  /** Document/source collections stored under the base root. */
  readonly collections: readonly KnowledgeCollection[]
  /** The current immutable snapshot records are served from. */
  readonly snapshot: {
    readonly id: string
    /** ISO timestamp of the last ingest. */
    readonly takenAt: string
    /** Digest over the ingested corpus; ingests re-verify. */
    readonly digest: string
    readonly recordCount: number
  }
  /** Retrieval strategies the base supports. */
  readonly retrievalProfiles: readonly RetrievalProfile[]
  /** Usage policies enforced by gates and the runtime. */
  readonly policies: DomainKnowledgePolicy
}

/**
 * Per-record metadata every ingested knowledge record carries — the basis
 * of citation, freshness and caliber checks by the Data gate.
 */
export interface KnowledgeRecordMetadata {
  /** Stable record id inside its collection. */
  readonly id: string
  /** Where the record came from (provider id, URL, file…). */
  readonly source: string
  /** ISO timestamp of observation (when the fact was captured). */
  readonly observedAt?: string
  /** Valid-time interval of the fact, when it applies to a period. */
  readonly validTime?: { readonly from?: string; readonly to?: string }
  /** Region the record is scoped to (e.g. `上海`). */
  readonly region?: string
  /** Unit of the recorded quantity, when numeric. */
  readonly unit?: string
  /** Data caliber note (e.g. `克而瑞口径`, `贝壳成出口径`). */
  readonly caliber?: string
  /** Sensitivity tier; `internal`/`confidential` never leave the org. */
  readonly sensitivity: 'public' | 'internal' | 'confidential'
  /** Content checksum for integrity verification. */
  readonly checksum: string
}

/** A capability a scenario requires, with binding constraints. */
export interface CapabilityRequirement {
  readonly capability: string
  /** Minimum acceptable proficiency for candidates. */
  readonly minProficiency?: Proficiency
  /** How many distinct fillers are needed. */
  readonly cardinality?: number
  /** Providers allowed to serve this capability; empty = any installed. */
  readonly allowedProviders?: readonly string[]
}

/** Routing constraints; assertions the resolver must honor. */
export interface RoutingPolicy {
  /** Hard constraints in assertion form (e.g. "行业研究 must be 主答"). */
  readonly assertions?: readonly string[]
  /** Stance pairing rules for对比 scenarios (optimist vs risk-flagger). */
  readonly stancePairing?: {
    readonly topic?: string
    readonly requireOptimist?: boolean
    readonly requireRisk?: boolean
  }
  /** Candidate expert ids as *hints*, never a fixed roster. */
  readonly candidateHints?: readonly string[]
}

/** Required/optional knowledge sources for a scenario. */
export interface KnowledgePolicy {
  readonly required: readonly string[]
  readonly optional?: readonly string[]
}

/** Allowed capability set for a scenario's tool usage. */
export interface ToolPolicy {
  readonly allowed: readonly string[]
  /** Provider ids that may substitute for each other, if any. */
  readonly fallbacks?: readonly { readonly from: string; readonly to: string }[]
}

/** User sign-off gate before team assembly. */
export interface ApprovalPolicy {
  readonly mode: 'none' | 'user-signoff'
  /** What the user approves (candidate roster, template params…). */
  readonly approves: 'roster' | 'parameters' | 'roster+parameters'
}

/** V2 scenario: task intent, references — no inline execution detail. */
export interface ScenarioV2 {
  readonly id: SafeId
  readonly version: VersionString
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly domain: string
  /** Controlled-vocabulary intents (e.g. `monthly-review`, `cross-validation`). */
  readonly intents: readonly string[]
  readonly requiredCapabilities: readonly CapabilityRequirement[]
  readonly routingPolicy: RoutingPolicy
  /** TeamTemplate id — validated to exist in the pack. */
  readonly teamTemplate: string
  /** OutputTemplate id — validated to exist in the pack. */
  readonly outputTemplate: string
  /** QualityPolicy id — validated to exist in the pack. */
  readonly qualityPolicy: string
  readonly knowledgePolicy: KnowledgePolicy
  readonly toolPolicy: ToolPolicy
  readonly approvalPolicy?: ApprovalPolicy
  readonly legacySource?: LegacySource
}

/** One role a team template needs filled (not an expert identity). */
export interface RoleSlot {
  readonly id: SafeId
  /** Capabilities a filler must claim. */
  readonly capabilities: readonly string[]
  readonly cardinality: { readonly min: number; readonly max: number }
  /** Diversity constraints (框架D: ≥2 fields; 同题对比: opposing stances). */
  readonly diversity?: {
    readonly fields?: number
    readonly stances?: number
    readonly tags?: readonly string[]
  }
  readonly approval?: 'none' | 'user-signoff'
}

/** Where a task input comes from: upstream task, knowledge, or tool. */
export interface InputBinding {
  readonly kind: 'task-output' | 'knowledge' | 'tool-capability' | 'parameter'
  /** Task id / provider scope / capability / parameter name respectively. */
  readonly ref: string
  readonly legacySource?: LegacySource
}

/** One task node of a compiled team DAG. */
export interface TaskTemplate {
  readonly id: SafeId
  /** RoleSlot id — validated to exist. */
  readonly role: string
  /** Task ids this task waits on — validated to exist and stay acyclic. */
  readonly dependsOn: readonly string[]
  readonly inputs: readonly InputBinding[]
  /** Capabilities this task may invoke (subset of scenario tool policy). */
  readonly allowedCapabilities: readonly string[]
  /** OutputTemplate section or template id constraining this task's output. */
  readonly outputSchema: string
  readonly retryPolicy: TaskRetryPolicy
  /** Human-facing subject/description (V1 compatibility keeps these). */
  readonly subject?: string
  readonly description?: string
  readonly legacySource?: LegacySource
}

/** Which quality policy+gate runs at this point of the template. */
export interface GateBinding {
  /** QualityPolicy id — validated to exist in the pack. */
  readonly policy: string
  /** Gate id inside that policy — validated to exist. */
  readonly gate: string
  /** Gate kinds that may satisfy this binding; empty = the gate's own kind. */
  readonly kinds?: readonly ('deterministic' | 'semantic' | 'visual')[]
  /** Where the binding applies (task ids or 'deliverable'). */
  readonly appliesTo: readonly string[]
}

/** What a template delivers and under which output template. */
export interface DeliverableBinding {
  readonly id: string
  /** OutputTemplate id — validated to exist in the pack. */
  readonly outputTemplate: string
  /** Task ids whose outputs compose this deliverable. */
  readonly fromTasks: readonly string[]
  readonly renderMode?: string
}

/** Declarative team composition: slots + DAG + gates + deliverables. */
export interface TeamTemplate {
  readonly id: SafeId
  readonly version: VersionString
  readonly schemaVersion: typeof SCHEMA_VERSION
  /** JSON Schema for template parameters (debate sides, fusion categories…). */
  readonly parameters?: Record<string, unknown>
  readonly slots: readonly RoleSlot[]
  readonly tasks: readonly TaskTemplate[]
  readonly gates: readonly GateBinding[]
  readonly deliverables: readonly DeliverableBinding[]
  readonly legacySource?: LegacySource
}

/** One required section of an output template. */
export interface SectionSpec {
  readonly id: string
  readonly required: boolean
  /** Word-count gate bounds, when the framework imposes them. */
  readonly maxWords?: number
  readonly minWords?: number
  /** Fields every instance of the section must carry (with source refs). */
  readonly fields?: readonly string[]
  /** Data requirements the Data gate checks (source/period/region/unit). */
  readonly requires?: readonly string[]
}

/** Rendering policy for one render mode (discussion vs final). */
export interface RenderPolicy {
  /** Anonymized annotations on (`discussion`) or off (`final`). */
  readonly anonymize: boolean
  /** Extra style policy id applied in this mode. */
  readonly stylePolicy?: string
}

/** Structure contract for a deliverable (§3.6). */
export interface OutputTemplate {
  readonly id: SafeId
  readonly version: VersionString
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly media: readonly ('markdown' | 'html' | 'pdf' | 'pptx' | 'json')[]
  readonly sections: readonly SectionSpec[]
  /** At least one render mode must exist; ids are policy-defined. */
  readonly renderModes: Readonly<Record<string, RenderPolicy>>
  /** Style policy id (lint rules for AI-flavor, transitions…). */
  readonly stylePolicy?: string
  readonly legacySource?: LegacySource
}

/** Kind of a quality gate implementation. */
export type GateKind = 'deterministic' | 'semantic' | 'visual'

/**
 * Phase of the fixed gate chain (§3.6):
 * `structure → data → compliance → format → style → semantic → final`.
 * The compiler orders bound gates by this chain; the runtime executes them
 * in that deterministic order.
 */
export type GatePhase = 'structure' | 'data' | 'compliance' | 'format' | 'style' | 'semantic' | 'final'

/** Per-task retry policy (three-tier retry of §4.5). */
export type TaskRetryPolicy = 'never' | 'provider-only' | 'quality-repair'

/** A single quality gate inside a policy. */
export interface QualityGateSpec {
  readonly id: string
  readonly kind: GateKind
  /** Output template section ids, task ids, or 'deliverable'. */
  readonly appliesTo: readonly string[]
  readonly severity: 'hard' | 'soft'
  /**
   * Position in the fixed gate chain; when absent the compiler derives a
   * deterministic phase from {@link GateKind} (deterministic→structure,
   * visual→format, semantic→semantic).
   */
  readonly phase?: GatePhase
  /**
   * Gate implementation id resolved against the injected evaluator registry
   * (`GateEvaluatorMap`); builtin deterministic evaluators ship via
   * `createBuiltinGateEvaluators`.
   */
  readonly implementation?: string
  /** Gate-specific configuration (thresholds, phrase lists…). */
  readonly config?: Record<string, unknown>
}

/** Named collection of gates referenced by scenarios/templates. */
export interface QualityPolicy {
  readonly id: SafeId
  readonly version: VersionString
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly gates: readonly QualityGateSpec[]
  /** Repair-loop cap for this policy (max 2 by design). */
  readonly maxRepairRounds?: number
  readonly legacySource?: LegacySource
}

/**
 * A reusable methodology body — an `agent-instructions` asset loaded
 * progressively at task-compile time (never injected into a persona). The
 * task DAG references a MethodPack id; the compiler splices its body into
 * exactly the tasks that need it, so unrelated turns never pay for it.
 */
export interface MethodPack {
  readonly id: SafeId
  readonly version: VersionString
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly name: string
  /** Fixed media type: methodology prose for agents, never executed. */
  readonly mediaType: 'agent-instructions'
  /** Fixed load policy: progressive (per-task), not persona-baked. */
  readonly load: 'progressive'
  /** Methodology text (steps/lenses/checklists). Static knowledge, never executed. */
  readonly body: string
  /** Capabilities this method assumes available, when any. */
  readonly assumesCapabilities?: readonly string[]
  /** Origin when contributed by a SkillPackage. */
  readonly fromSkillPackage?: string
}

/**
 * SkillPackage manifest (§3.7): a versioned distribution container — not a
 * provider. Skills are LOCAL-ONLY: `source` points at an already-installed
 * local directory (builtin pack or workspace overlay); the loader never
 * performs network access, and `upstreamProvenance` is an audit-only record
 * of where the content was originally obtained offline. After installation
 * the package *contributes* first-class objects (MethodPack /
 * KnowledgeProvider / OutputTemplate / QualityPolicy / tool requirements /
 * TeamTemplate) referenced by id; every contribution id must resolve inside
 * the same pack. Executable scripts are declared separately and must
 * register as controlled ToolProviders to be invocable.
 */
export interface SkillPackageManifest {
  readonly id: SafeId
  readonly version: VersionString
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly source: {
    /** Where the skill is installed locally. */
    readonly kind: 'builtin' | 'workspace'
    /**
     * Local root of the installed skill, relative to its owner (builtin pack
     * root or the workspace knowledge dir) — e.g. `skills/video-shotcraft`.
     * Never a URL; must stay a safe relative path.
     */
    readonly root: string
    /** Whole-package SHA-256 digest; re-installs/upgrades must re-verify. */
    readonly digest: string
    /** SPDX id or name; missing license implies internalOnly. */
    readonly license?: string
    /**
     * Audit-only record of the offline upstream origin (repository URL/name
     * and revision). The runtime never contacts it.
     */
    readonly upstreamProvenance?: {
      readonly repository: string
      readonly revision: string
    }
  }
  readonly contributions: {
    readonly methodPacks?: readonly string[]
    readonly knowledgeProviders?: readonly string[]
    readonly outputTemplates?: readonly string[]
    readonly qualityPolicies?: readonly string[]
    /** Required capability ids — declared, never self-executed. */
    readonly toolRequirements?: readonly string[]
    readonly teamTemplates?: readonly string[]
  }
  /** Large media kept out of prompt loads; digest-pinned, lazily read. */
  readonly lazyMedia?: ReadonlyArray<{ readonly path: string; readonly bytes: number; readonly sha256: string }>
  readonly permissions: {
    /** Script entrypoints allowed to register as controlled ToolProviders. */
    readonly execScripts: readonly string[]
    /** No license (or unclear) ⇒ outputs must not leave the org. */
    readonly internalOnly?: boolean
  }
}

/** Pack-level metadata (pack.json). */
export interface PackMeta {
  readonly id: SafeId
  readonly version: VersionString
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly name: string
  readonly description?: string
  /** Other pack ids this pack builds on. */
  readonly dependsOn?: readonly string[]
  /** Caliber declarations (data-source mappings) for the Data gate. */
  readonly caliberDeclarations?: Record<string, string>
}

/**
 * A complete V2 domain pack: the only unit the validator accepts.
 * Every cross-reference is resolved *within the pack* during validation.
 */
export interface DomainPackV2 {
  readonly pack: PackMeta
  readonly experts: readonly ExpertV2[]
  readonly teamTemplates: readonly TeamTemplate[]
  readonly outputTemplates: readonly OutputTemplate[]
  readonly qualityPolicies: readonly QualityPolicy[]
  readonly scenarios: readonly ScenarioV2[]
  /** Tool provider manifests this pack binds to (capabilities by name). */
  readonly toolProviders: readonly ToolProviderManifest[]
  /** Knowledge provider manifests this pack binds to. */
  readonly knowledgeProviders: readonly KnowledgeProviderManifest[]
  /** Structured domain knowledge bases served by this pack's providers. */
  readonly domainKnowledge: readonly DomainKnowledgeManifest[]
  /** Reusable methodology bodies (contributed by packs or skill packages). */
  readonly methodPacks: readonly MethodPack[]
  /** Installed skill packages whose contributions resolve inside this pack. */
  readonly skillPackages: readonly SkillPackageManifest[]
}

/** Severity of one validation diagnostic. */
export type DiagnosticSeverity = 'error' | 'warning' | 'info'

/**
 * One issue a gate raises against an artifact, with a location and evidence
 * so the repair loop stays *targeted*: only the section/task the issue
 * points at gets a repair task, never a whole-chain re-run (§4.4/§8.3).
 */
export interface GateIssue {
  /** Stable machine code (e.g. `missing-section`, `number-without-source`). */
  readonly code: string
  readonly severity: 'info' | 'warning' | 'error'
  /** Where in the artifact the issue lives (section id, table, line, DOM path…). */
  readonly location?: string
  /** The offending excerpt or supporting evidence (quoted text, cell value…). */
  readonly evidence?: string
  /** Optional actionable correction hint consumed by the targeted repair task. */
  readonly correction?: string
}

/** Result of evaluating one gate over one artifact (§3.6). */
export interface GateResult {
  readonly gateId: string
  readonly status: 'pass' | 'warn' | 'fail'
  /** 1–5 rubric score when the gate scores instead of binary verdicts. */
  readonly score?: number
  readonly issues: readonly GateIssue[]
  /** Hashes of the artifact(s) this result was computed over. */
  readonly artifactHashes?: Readonly<Record<string, string>>
  readonly evaluatedAt: string
}

/** One validation finding; validators never return a bare boolean. */
export interface PackDiagnostic {
  /** Stable machine code (e.g. `duplicate-id`, `dag-cycle`). */
  readonly code: string
  /** JSON path of the offending value inside the pack. */
  readonly path: string
  readonly message: string
  readonly severity: DiagnosticSeverity
}

/** Result of validating an unknown document as a {@link DomainPackV2}. */
export interface ValidationResult<T> {
  /** True only when no error-severity diagnostics exist. */
  readonly ok: boolean
  /** The validated value; present iff ok (warnings may still exist). */
  readonly value?: T
  readonly diagnostics: readonly PackDiagnostic[]
}
