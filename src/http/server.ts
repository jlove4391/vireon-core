import "dotenv/config";
import express from "express";
import { briefingsRouter } from "./routes/briefings.js";
import { eloraMessagesRouter } from "./routes/eloraMessages.js";

// Phase 6A §7: one dev-only HTTP server. No auth beyond the dev-identity
// placeholder (§6). Not intended to be deployed as-is.
// Phase 6M: adds the Operator Deck's two read/write routes alongside the
// existing ELORA console route -- same server, same dev-identity model.

const PORT = Number(process.env.HTTP_PORT ?? 4300);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(eloraMessagesRouter);
app.use(briefingsRouter);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Vireon CORE dev HTTP server listening on http://localhost:${PORT}`);
});
