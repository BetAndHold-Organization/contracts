import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  RPC_URL: z.string().url(),
  RPC_WS_URL: z.string().optional(),
  DEPLOYMENTS_PATH: z.string(),
  HARDFORK_MNEMONIC: z.string().min(12),
  ADMIN_PRIVATE_KEY: z.string().optional(),
  DATABASE_URL: z.string().url(),
  ADMIN_API_KEY: z.string().optional(),
  START_BLOCK: z.string().optional(),
});

export const env = envSchema.parse(process.env);

