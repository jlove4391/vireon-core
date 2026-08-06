/** PR 6 §25: minimal Recall@k / Precision@k utilities -- not a generalized ML evaluation framework. */

export function recallAtK(retrievedIds: readonly string[], relevantIds: readonly string[], k: number): number {
  if (relevantIds.length === 0) {
    throw new Error("recallAtK: relevantIds must not be empty");
  }
  const topK = new Set(retrievedIds.slice(0, k));
  const hitCount = relevantIds.filter((id) => topK.has(id)).length;
  return hitCount / relevantIds.length;
}

/** Per §25's own formula: relevant retrieved in top k / k. The golden fixture is expected to return at least k candidates for every query it's measured against. */
export function precisionAtK(retrievedIds: readonly string[], relevantIds: readonly string[], k: number): number {
  const relevantSet = new Set(relevantIds);
  const topK = retrievedIds.slice(0, k);
  const hitCount = topK.filter((id) => relevantSet.has(id)).length;
  return hitCount / k;
}

export interface RetrievalEvaluationReport {
  query: string;
  expectedIds: string[];
  retrievedIds: string[];
  recallAt5: number;
  precisionAt5: number;
}

export function evaluateRetrieval(
  query: string,
  retrievedIds: readonly string[],
  relevantIds: readonly string[],
  k = 5,
): RetrievalEvaluationReport {
  return {
    query,
    expectedIds: [...relevantIds],
    retrievedIds: [...retrievedIds],
    recallAt5: recallAtK(retrievedIds, relevantIds, k),
    precisionAt5: precisionAtK(retrievedIds, relevantIds, k),
  };
}

export function formatEvaluationReport(report: RetrievalEvaluationReport): string {
  return [
    `query: ${report.query}`,
    `expected: [${report.expectedIds.join(", ")}]`,
    `retrieved: [${report.retrievedIds.join(", ")}]`,
    `Recall@5: ${report.recallAt5}`,
    `Precision@5: ${report.precisionAt5}`,
  ].join("\n");
}
