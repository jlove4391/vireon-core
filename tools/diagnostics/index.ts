import { pool } from "../../src/db/pool.js";
import { listAcceptanceReports } from "./acceptanceReports.js";
import { listTenants, listWorkOrdersForTenant } from "./tenants.js";
import { printAcceptanceReports, printTenantsTable, printWorkOrderDetail, printWorkOrdersTable } from "./format.js";
import { getWorkOrderDetail } from "./workOrder.js";

const USAGE = `Usage:
  pnpm diagnostics tenants
  pnpm diagnostics tenant --tenant <tenant_id> [--limit N]
  pnpm diagnostics work-order --tenant <tenant_id> <work_order_id>
  pnpm diagnostics acceptance`;

interface ParsedArgs {
  flags: Record<string, string>;
  positionals: string[];
}

function parseArgs(args: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
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
