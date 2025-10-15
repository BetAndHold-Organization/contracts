import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema/db.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: "./data/graph.sqlite",
  },
});

