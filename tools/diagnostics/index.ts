import { pool } from "../../src/db/pool.js";
import { promoteMemoryCandidate } from "../../src/elora/memory/promoteMemoryCandidate.js";
import { reviewMemoryCandidate } from "../../src/elora/memory/reviewMemoryCandidate.js";
import { listAcceptanceReports } from "./acceptanceReports.js";
import { listMemoryCandidates } from "./memory.js";
import { listTenants, listWorkOrdersForTenant } from "./tenants.js";
import {
  printAcceptanceReports,
  printMemoryCandidatesTable,
  printTenantsTable,
  printWorkOrderDetail,
  printWorkOrdersTable,
} from "./format.js";
import { getWorkOrderDetail } from "./workOrder.js";

const USAGE = `Usage:
  pnpm diagnostics tenants
  pnpm diagnostics tenant --tenant <tenant_id> [--limit N]
  pnpm diagnostics work-order --tenant <tenant_id> <work_order_id>
  pnpm diagnostics acceptance
  pnpm diagnostics memory review <candidateId> --tenant <tenant_id> --actor <actor_id> --decision=approved|rejected [--note="..."]
  pnpm diagnostics memory promote <candidateId> --tenant <tenant_id> --actor <actor_id>
  pnpm diagnostics memory list --tenant <tenant_id> [--status=proposed|approved|rejected|promoted] [--scope=general]`;

interface ParsedArgs {
  flags: Record<string, string>;
  positionals: string[];
}

/** Supports both `--flag value` and `--flag=value` -- the latter for the memory subcommands' own usage examples. */
function parseArgs(args: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg?.startsWith("--")) {
      const body = arg.slice(2);
      const eqIndex = body.indexOf("=");
      if (eqIndex !== -1) {
        flags[body.slice(0, eqIndex)] = body.slice(eqIndex + 1);
        continue;
      }
      const key = body;
      const next = args[i + 1];
      flags[key] = next ?? "";
      i++;
    } else if (arg) {
      positionals.push(arg);
    }
  }

  return { flags, positionals };
}

async function run(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positionals } = parseArgs(rest);

  switch (command) {
    case "tenants": {
      printTenantsTable(await listTenants());
      return;
    }

    case "tenant": {
      const tenantId = flags.tenant;
      if (!tenantId) {
        throw new Error(`tenant command requires --tenant <tenant_id>\n\n${USAGE}`);
      }
      const limit = flags.limit ? Number(flags.limit) : 20;
      printWorkOrdersTable(await listWorkOrdersForTenant(tenantId, limit));
      return;
    }

    case "work-order": {
      const tenantId = flags.tenant;
      const workOrderId = positionals[0];
      if (!tenantId || !workOrderId) {
        throw new Error(`work-order command requires --tenant <tenant_id> <work_order_id>\n\n${USAGE}`);
      }
      const detail = await getWorkOrderDetail(tenantId, workOrderId);
      if (!detail) {
        console.log(`No WorkOrder ${workOrderId} found for tenant ${tenantId}.`);
        console.log(
          "If you expected a result, confirm you're using the correct tenant -- run 'pnpm diagnostics tenants' to check.",
        );
        return;
      }
      printWorkOrderDetail(detail);
      return;
    }

    case "acceptance": {
      printAcceptanceReports(listAcceptanceReports());
      return;
    }

    case "memory": {
      const [subcommand, ...subPositionals] = positionals;

      switch (subcommand) {
        case "review": {
          const candidateId = subPositionals[0];
          const tenantId = flags.tenant;
          const actorId = flags.actor;
          const decision = flags.decision;
          if (!candidateId || !tenantId || !actorId || (decision !== "approved" && decision !== "rejected")) {
            throw new Error(`memory review requires <candidateId> --tenant <tenant_id> --actor <actor_id> --decision=approved|rejected\n\n${USAGE}`);
          }
          const reviewed = await reviewMemoryCandidate({
            tenantId,
            candidateId,
            actorId,
            decision,
            note: flags.note ? flags.note : null,
          });
          console.log(`MemoryCandidate ${reviewed.id} review_status -> ${reviewed.review_status}`);
          console.table([reviewed]);
          return;
        }

        case "promote": {
          const candidateId = subPositionals[0];
          const tenantId = flags.tenant;
          const actorId = flags.actor;
          if (!candidateId || !tenantId || !actorId) {
            throw new Error(`memory promote requires <candidateId> --tenant <tenant_id> --actor <actor_id>\n\n${USAGE}`);
          }
          const record = await promoteMemoryCandidate({ tenantId, candidateId, actorId });
          console.log(`MemoryCandidate ${candidateId} promoted -> MemoryRecord ${record.id}`);
          console.table([record]);
          return;
        }

        case "list": {
          const tenantId = flags.tenant;
          if (!tenantId) {
            throw new Error(`memory list requires --tenant <tenant_id>\n\n${USAGE}`);
          }
          const candidates = await listMemoryCandidates(tenantId, {
            status: flags.status,
            scope: flags.scope,
            limit: flags.limit ? Number(flags.limit) : undefined,
          });
          printMemoryCandidatesTable(candidates);
          return;
        }

        default: {
          console.log(USAGE);
          process.exitCode = subcommand ? 1 : 0;
          return;
        }
      }
    }

    default: {
      console.log(USAGE);
      process.exitCode = command ? 1 : 0;
    }
  }
}

run()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
