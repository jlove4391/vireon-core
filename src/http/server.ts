import "dotenv/config";
import express from "express";
import { eloraMessagesRouter } from "./routes/eloraMessages.js";

// Phase 6A §7: one dev-only HTTP server, one route. No auth beyond the
// dev-identity placeholder (§6). Not intended to be deployed as-is.

const PORT = Number(process.env.HTTP_PORT ?? 4300);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(eloraMessagesRouter);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Vireon CORE dev HTTP server listening on http://localhost:${PORT}`);
});
