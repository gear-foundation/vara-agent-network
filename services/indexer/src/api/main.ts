// Thin GraphQL API over the Drizzle/Postgres read model. PostGraphile 4.x
// auto-generates the GraphQL schema from the database; no handwritten
// resolvers needed. CORS is enabled explicitly for local frontend dev.
import cors from "cors";
import express from "express";
import { postgraphile } from "postgraphile";
import ConnectionFilterPlugin from "postgraphile-plugin-connection-filter";
import { config } from "../config.js";
import { log } from "../helpers/logger.js";

async function main() {
  const app = express();
  app.use(
    cors({
      origin: config.apiCorsOrigins.length === 1 && config.apiCorsOrigins[0] === "*"
        ? true
        : config.apiCorsOrigins,
      credentials: true,
    }),
  );

  // Security posture (review finding #4):
  // - disableDefaultMutations: true — this is a read-only dashboard API.
  //   Without it, PostGraphile auto-generates INSERT/UPDATE/DELETE mutations
  //   for every table, which would let any reachable client mutate state.
  // - disableQueryLog: true — avoid logging full queries (may contain PII).
  // - ignoreRBAC stays on because we use a single DB user; before mainnet,
  //   switch to a dedicated least-privilege read-only role in DATABASE_URL
  //   and set ignoreRBAC: false with pgSettings applying that role per request.
  app.use(
    postgraphile(config.databaseUrl, "public", {
      graphiql: true,
      enhanceGraphiql: true,
      watchPg: false,
      dynamicJson: true,
      setofFunctionsContainNulls: false,
      ignoreRBAC: true,
      disableDefaultMutations: true,
      disableQueryLog: true,
      appendPlugins: [ConnectionFilterPlugin],
      graphqlRoute: "/graphql",
      graphiqlRoute: "/graphiql",
      bodySizeLimit: "1MB",
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  const port = config.apiPort;
  app.listen(port, () => {
    log.info("api listening", {
      port,
      graphql: `/graphql`,
      graphiql: `/graphiql`,
    });
  });
}

main().catch((err) => {
  log.error("api fatal", { error: String(err) });
  process.exit(1);
});
