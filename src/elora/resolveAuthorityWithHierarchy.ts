import { withTenantTransaction } from "../db/withTenantTransaction.js";
import { classifyAuthority, type ClassifyAuthorityInput } from "./classifyAuthority.js";
import { AUTHORITY_OUTCOME_TO_REASON_CODE, type EloraAuthorityClassification } from "./types.js";

// Phase 6C §5.2: match_criteria's shape, resolved here (6B deliberately left
// it undefined). contentPattern is tested the same way classifyAuthority.ts
// tests its own cues -- a case-insensitive RegExp against message content.
// No priority/scoring system: first match wins, which is all a table with
// zero real-world rows in it warrants today.
export interface StandingRuleMatchCriteria {
  contentPattern: string;
  taskType?: string;
}

export interface ResolveAuthorityWithHierarchyInput extends ClassifyAuthorityInput {
  tenantId: string;
  /**
   * Lazily resolves the actor id the hierarchy walk starts from. Only
   * invoked when classifyAuthority()'s baseline outcome is an ordinary
   * (non-floor-protected) escalate -- i.e. only when a walk is actually
   * about to happen. This keeps the resolution engine itself fully generic
   * (it never queries for or knows about "ELORA"); which persona a given
   * pipeline represents is the caller's concern -- see ingestUserMessage.ts
   * and Phase 6C §6's stated limitation.
   */
  resolveStartingActorId: () => Promise<string>;
}

export interface ResolvedAuthorityClassification extends EloraAuthorityClassification {
  /** Phase 6C §5.4: the authority_standing_rules row that resolved this outcome, or null if none did. */
  resolvedViaStandingRuleId: string | null;
}

interface StandingRuleRow {
  id: string;
  match_criteria: StandingRuleMatchCriteria;
}

function matchesCriteria(criteria: StandingRuleMatchCriteria, content: string, taskType: string): boolean {
  if (typeof criteria.taskType === "string" && criteria.taskType !== taskType) {
    return false;
  }
  if (typeof criteria.contentPattern !== "string" || criteria.contentPattern.length === 0) {
    return false;
  }
  try {
    return new RegExp(criteria.contentPattern, "i").test(content);
  } catch {
    // Malformed pattern stored in a rule -- treat as no match rather than
    // letting a bad row take down the whole resolution walk.
    return false;
  }
}

function unresolved(baseline: EloraAuthorityClassification): ResolvedAuthorityClassification {
  return { ...baseline, resolvedViaStandingRuleId: null };
}

/**
 * Wraps classifyAuthority() -- does not replace or duplicate its logic.
 * Phase 6C §5.1: only an ordinary (non-floor-protected) escalate outcome is
 * ever eligible for silent resolution. Walks the reporting chain starting
 * from the given actor, checking each successive superior's active,
 * approval-polarity standing rules for a match, arbitrary chain depth. The
 * first matching rule anywhere in the chain wins; reaching the Sovereign
 * (reports_to_actor_id IS NULL) with no match is a genuine, unresolved
 * live escalation, identical to pre-6C behavior.
 */
export async function resolveAuthorityWithHierarchy(
  input: ResolveAuthorityWithHierarchyInput,
): Promise<ResolvedAuthorityClassification> {
  const baseline = classifyAuthority({
    content: input.content,
    taskType: input.taskType,
    resolvedProjectId: input.resolvedProjectId,
  });

  if (baseline.outcome !== "escalate" || baseline.floorProtected) {
    return unresolved(baseline);
  }

  const startingActorId = await input.resolveStartingActorId();

  return withTenantTransaction(input.tenantId, async (client) => {
    let currentActorId = startingActorId;

    for (;;) {
      const currentResult = await client.query<{ reports_to_actor_id: string | null }>(
        "SELECT reports_to_actor_id FROM actors WHERE id = $1 AND tenant_id = $2",
        [currentActorId, input.tenantId],
      );
      const superior = currentResult.rows[0]?.reports_to_actor_id ?? null;
      if (!superior) {
        // Current actor has no superior -- either it is the Sovereign, or
        // it's an actor with no resolvable chain. Either way, nothing left
        // to check.
        break;
      }

      const rulesResult = await client.query<StandingRuleRow>(
        `SELECT id, match_criteria FROM authority_standing_rules
         WHERE tenant_id = $1 AND scope_actor_id = $2 AND polarity = 'approve' AND status = 'active'
         ORDER BY created_at ASC`,
        [input.tenantId, superior],
      );

      const matched = rulesResult.rows.find((rule) => matchesCriteria(rule.match_criteria, input.content, input.taskType));

      if (matched) {
        return {
          outcome: "act_and_report",
          requires_human_gatekeeper: false,
          reason: `Resolved via standing authorization held by ${superior} (rule ${matched.id})`,
          reasonCode: AUTHORITY_OUTCOME_TO_REASON_CODE.act_and_report,
          risk_level: baseline.risk_level,
          required_setup: null,
          floorProtected: false,
          resolvedViaStandingRuleId: matched.id,
        };
      }

      currentActorId = superior;
    }

    return unresolved(baseline);
  });
}
