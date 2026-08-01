/**
 * Canonical `interpreted_intent` synthesis for a delegated child WorkOrder --
 * AUTHORITY_AND_DELEGATION.md §6.1: a delegated child correctly reuses its
 * parent's thread_id/message_id ("context inheritance by reference," not a
 * bug), but that reused message is the *parent's* original request, not
 * something the child itself received. §6.1 requires every delegated child
 * to carry a real interpreted_intent synthesized from the delegation itself
 * -- this is the field that actually identifies what the child WorkOrder is
 * about, never inherited verbatim from the parent's own intent, and never
 * left blank.
 *
 * Persona-neutral, same reasoning as writeDelegationReceipt.ts living here
 * rather than in src/elora/: delegation is not an ELORA-specific concept.
 * Whoever writes the first real caller (Nexora/Kaz/Jynx) should call this
 * directly rather than reconstructing the convention from doctrine.
 */
export function describeDelegation(parentPersonaName: string, delegationMode: "supervised" | "peer", reason: string): string {
  return `Delegated by ${parentPersonaName} (${delegationMode}): ${reason}`;
}
