import { PrismaClient } from "@prisma/client";

import { env } from "./config.js";

export const db = new PrismaClient({
  datasources: {
    db: {
      url: env.DATABASE_URL,
    },
  },
});
