import { ApolloServer } from "@apollo/server";
import { createServer } from "http";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { expressMiddleware } from "@apollo/server/express4";
import { apiRouter } from "./api/router.js";

import { env } from "./config.js";
import { schema } from "./schema.js";
import { db } from "./db.js";
async function bootstrap() {
  const server = new ApolloServer({ schema });
  await server.start();

  const app = express();
  app.use(cors(), bodyParser.json());
  app.use("/api", apiRouter);            // serve REST here
  app.use("/graphql", expressMiddleware(server)); // serve GraphQL only on /graphql
  const httpServer = createServer(app);

  httpServer.listen({ port: env.PORT }, () => {
    console.log(`🚀 GraphQL server ready at http://localhost:${env.PORT}/graphql`);
  });
}

bootstrap().catch((error) => {
  console.error("GraphQL server failed", error);
  process.exitCode = 1;
  db.$disconnect().catch(() => undefined);
});
