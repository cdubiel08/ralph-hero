/**
 * Named filter profiles for Ralph agent roles.
 *
 * Maps profile names (e.g., "analyst-triage", "builder-active") to sets of
 * filter parameters for list_issues and list_project_items. Agents use profiles
 * instead of hardcoding individual filter params.
 */

// --- Types ---

/**
 * Filter parameters that a profile can set.
 * Subset of the params accepted by list_issues and list_project_items.
 */
export interface ProfileFilterParams {
  workflowState?: string;
  estimate?: string;
  priority?: string;
  state?: "OPEN" | "CLOSED";
  limit?: number;
}

// --- Profile Registry ---

/**
 * Named filter profiles mapping to concrete filter parameter objects.
 * Profiles use kebab-case with role prefix: role-purpose.
 */
export const FILTER_PROFILES: Record<string, ProfileFilterParams> = {
  "analyst-triage": {
    workflowState: "Backlog",
    // TODO: add `no: "estimate"` when GH-141 (has/no presence filters) lands
  },
  "analyst-research": {
    workflowState: "Research Needed",
  },
  "builder-active": {
    workflowState: "In Progress",
  },
  "builder-planned": {
    workflowState: "Plan in Review",
  },
  "validator-review": {
    workflowState: "Plan in Review",
    // TODO: multi-value workflowState for "Plan in Review" OR "In Review" when supported
  },
  "integrator-merge": {
    workflowState: "In Review",
  },
};

/**
 * Valid profile names, derived from the registry keys.
 */
export const VALID_PROFILE_NAMES: string[] = Object.keys(FILTER_PROFILES);

// --- Public API ---

/**
 * Expand a named profile into its filter parameters.
 *
 * Returns a shallow copy of the profile's filter params (safe to mutate).
 * Throws if the profile name is not recognized.
 */
export function expandProfile(name: string): ProfileFilterParams {
  const profile = FILTER_PROFILES[name];
  if (!profile) {
    throw new Error(
      `Unknown filter profile "${name}". ` +
        `Valid profiles: ${VALID_PROFILE_NAMES.join(", ")}. ` +
        `Recovery: retry with one of the valid profile names listed above.`,
    );
  }
  return { ...profile };
}
