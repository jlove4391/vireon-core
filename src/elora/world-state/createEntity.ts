import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "../../db/withTenantTransaction.js";
import { entityAliasSchema, type EntityAlias } from "../../schemas/entityAlias.js";
import { entitySchema, type Entity } from "../../schemas/entity.js";
import { InvalidEntityInputError } from "./errors.js";

export interface CreateEntityInput {
  tenantId: string;
  entityType: string;
  canonicalName: string;
  aliases?: string[];
}

export interface CreateEntityResult {
  entity: Entity;
  aliases: EntityAlias[];
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function rowToEntity(row: Record<string, unknown>): Entity {
  return entitySchema.parse({
    id: row.id,
    tenant_id: row.tenant_id,
    entity_type: row.entity_type,
    canonical_name: row.canonical_name,
    created_at: toIso(row.created_at as string | Date),
  });
}

function rowToAlias(row: Record<string, unknown>): EntityAlias {
  return entityAliasSchema.parse({
    id: row.id,
    tenant_id: row.tenant_id,
    entity_id: row.entity_id,
    alias: row.alias,
    created_at: toIso(row.created_at as string | Date),
  });
}

/**
 * Non-empty entityType/canonicalName/each alias, and rejects exact duplicate
 * aliases within the same request outright rather than silently deduping
 * them -- a caller asking to create the same alias twice made a mistake
 * worth surfacing, not a no-op worth hiding.
 */
function validateInput(input: CreateEntityInput): string[] {
  if (!input.entityType.trim()) {
    throw new InvalidEntityInputError("entityType must not be empty");
  }
  if (!input.canonicalName.trim()) {
    throw new InvalidEntityInputError("canonicalName must not be empty");
  }

  const aliases = input.aliases ?? [];
  const seen = new Set<string>();
  for (const alias of aliases) {
    if (!alias.trim()) {
      throw new InvalidEntityInputError("alias must not be empty");
    }
    if (seen.has(alias)) {
      throw new InvalidEntityInputError(`duplicate alias in request: ${alias}`);
    }
    seen.add(alias);
  }

  return aliases;
}

/**
 * PR 8 §24: explicit-only entity creation. No fuzzy matching, no
 * lookup-before-create attempting to discover duplicates, no canonical-name
 * merge -- two createEntity() calls with identical canonicalName produce two
 * distinct entities, deliberately. Entity + its explicit aliases (if any)
 * commit atomically in one tenant transaction.
 */
export async function createEntity(input: CreateEntityInput): Promise<CreateEntityResult> {
  const aliases = validateInput(input);

  return withTenantTransaction(input.tenantId, async (client) => {
    const now = new Date().toISOString();
    const entityId = randomUUID();

    const entityResult = await client.query(
      `INSERT INTO entities (id, tenant_id, entity_type, canonical_name, created_at)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [entityId, input.tenantId, input.entityType, input.canonicalName, now],
    );
    const entity = rowToEntity(entityResult.rows[0] as Record<string, unknown>);

    const aliasRows: EntityAlias[] = [];
    for (const alias of aliases) {
      const aliasResult = await client.query(
        `INSERT INTO entity_aliases (id, tenant_id, entity_id, alias, created_at)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *`,
        [randomUUID(), input.tenantId, entityId, alias, now],
      );
      aliasRows.push(rowToAlias(aliasResult.rows[0] as Record<string, unknown>));
    }

    return { entity, aliases: aliasRows };
  });
}
