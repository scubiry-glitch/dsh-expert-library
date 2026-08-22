/**
 * Expert Library domain types.
 *
 * An expert is a preset team-member profile: identity, role, a self-contained
 * persona (system prompt), a preset AI model route (provider/model/effort),
 * and an optional knowledge pack folder. A scenario is a preset collaboration
 * template: which experts to assemble, and a task DAG with dependencies.
 *
 * Both registries support builtin definitions plus user-supplied ones placed
 * in the knowledge pack folders (loaded at first use, so packs can be added
 * without rebuilding the plugin).
 * @module dsh-expert-library/expert-library/types
 */

/** Preset LLM route for one expert member. */
export interface ExpertModelRoute {
  /** LLM provider route registered in the harness (e.g. `deepseek-official`). */
  readonly provider: string
  /** Provider-owned model id (e.g. `deepseek-v4-flash`). */
  readonly model: string
  /** Reasoning effort id supported by the target model, or omitted for the target default. */
  readonly reasoningEffort?: string
}

/**
 * One expert profile. Members spawned from an expert use its persona and
 * preset model route; knowledge under `<knowledgeDir>/experts/<id>/` is
 * pointed to by the persona for read-only consultation.
 */
export interface Expert {
  /** Stable id used by `expert_teams_add_member(..., expert=<id>)`. */
  readonly id: string
  /** Display name (also the default member name when added by expert id). */
  readonly name: string
  /** One-line role summary, e.g. `security reviewer`. */
  readonly role: string
  /** Detailed professional background injected into the member persona. */
  readonly background: string
  /** Working principles injected into the member persona. */
  readonly principles: readonly string[]
  /** What deliverables this expert is responsible for. */
  readonly deliverables: readonly string[]
  /** Preset AI model route; falls back to plugin default, then the captain's route. */
  readonly model?: ExpertModelRoute
  /** Scenario ids this expert is recommended for. */
  readonly suitedFor?: readonly string[]
}

/** One task node of a scenario's preset task DAG. */
export interface ScenarioTaskTemplate {
  /** Brief title; the id is derived (`t1`, `t2`, … in array order). */
  readonly subject: string
  /** What needs to be done, in detail. */
  readonly description?: string
  /** Zero-based indexes into the same array this task depends on. */
  readonly dependsOn?: readonly number[]
  /** Expert id that should own this task (added as a member if missing). */
  readonly expert?: string
}

/**
 * Optional external skill binding of a scenario: when applied, the plugin
 * reads the locally-installed skill's SKILL.md and makes it available to
 * the team as reference material. Skills are local-only — the runtime
 * never fetches from GitHub or any HTTP endpoint.
 */
export interface ScenarioSkillBinding {
  /** Local skill id: the folder name under `<knowledgeDir>/skills/`. */
  readonly id: string
  /** Skill display name; defaults to the id. */
  readonly name?: string
  /** One-line purpose note injected into the team description. */
  readonly purpose?: string
  /** Zero-based task index that should receive the skill reference; defaults to the final task. */
  readonly appliesToTaskIndex?: number
}

/**
 * One collaboration scenario: a preset assembly of experts and a task DAG,
 * applied with `expert_teams_scenario_apply`.
 */
export interface Scenario {
  /** Stable id used by `expert_teams_scenario_apply(scenario=<id>)`. */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** What the scenario is for; also the default team goal description. */
  readonly description: string
  /** Expert ids to assemble (in recommended order). */
  readonly experts: readonly string[]
  /** Preset task DAG; dependencies reference indexes in this array. */
  readonly tasks: readonly ScenarioTaskTemplate[]
  /** Final deliverable spec appended to the captain's protocol. */
  readonly deliverable: string
  /** Extra knowledge pack folder name under `<knowledgeDir>/scenarios/`. */
  readonly knowledge?: string
  /** Optional external skill made available to the team (SKILL.md as reference). */
  readonly skill?: ScenarioSkillBinding
}

/** Registry of experts and scenarios, resolved at plugin start. */
export interface ExpertLibrary {
  readonly experts: ReadonlyMap<string, Expert>
  readonly scenarios: ReadonlyMap<string, Scenario>
}
