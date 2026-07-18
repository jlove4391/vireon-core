import type { EloraMessageResponse } from "../lib/api";
import { Card } from "./Card";

interface ActionCardProps {
  result: EloraMessageResponse;
}

const BLOCKED_TITLES: Record<string, string> = {
  escalate: "Action requires authorization",
  setup_required: "Action requires setup",
  capability_missing: "Capability not available",
  refuse: "Action refused",
};

/**
 * Truthfulness rules (handoff §10.2, carried from doc 24 §4.1 / Phase 4-5
 * doctrine): no simulated typing, no fake progress, no invented substeps.
 * If toolInvocationId/artifactId are null, nothing tool-related renders --
 * the caller must not mount this component at all in that case. If
 * blockedReceiptId is set, the blocked-state card renders, never a success
 * card. EloraMessageResponse carries no `required_setup` free-text field,
 * so the blocked explanation uses responseText (the one human-readable
 * field the API actually returns) rather than inventing one.
 *
 * Phase 6E: reads the flattened result.artifactFilename rather than
 * reaching into a raw intent object -- the backend's internal
 * EloraStructuredIntent never crosses the wire.
 */
export function ActionCard({ result }: ActionCardProps) {
  const toolRan = Boolean(result.toolInvocationId && result.artifactId);

  if (toolRan) {
    const filename = result.artifactFilename ?? "(filename unavailable)";
    return (
      <Card glow="cyan" className="text-sm">
        <p className="font-heading text-accent-cyan-glow">Artifact created: {filename}</p>
        <dl className="mt-2 space-y-1 text-text-secondary">
          <div>
            <dt className="inline font-medium text-text-primary">Authority: </dt>
            <dd className="inline">{result.authorityOutcome}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-text-primary">Tool: </dt>
            <dd className="inline">core.artifact.write</dd>
          </div>
          <div>
            <dt className="inline font-medium text-text-primary">Status: </dt>
            <dd className="inline">{result.finalWorkOrderStatus}</dd>
          </div>
        </dl>
      </Card>
    );
  }

  if (result.blockedReceiptId && result.authorityOutcome) {
    const title = BLOCKED_TITLES[result.authorityOutcome] ?? "Action blocked";
    return (
      <Card glow="violet" className="text-sm">
        <p className="font-heading text-accent-violet-glow">{title}</p>
        <dl className="mt-2 space-y-1 text-text-secondary">
          <div>
            <dt className="inline font-medium text-text-primary">Authority: </dt>
            <dd className="inline">{result.authorityOutcome}</dd>
          </div>
        </dl>
        <p className="mt-2 text-text-secondary">{result.responseText}</p>
      </Card>
    );
  }

  return null;
}
