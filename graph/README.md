# GraphQL Admin API

## Environment variables

Create a `.env` file for local development with the following keys:

- `PORT` (optional, default `4000`)
- `RPC_URL` (Hardhat node URL, e.g. `http://127.0.0.1:8545`)
- `RPC_WS_URL` (optional ws endpoint, e.g. `ws://127.0.0.1:8545`)
- `DEPLOYMENTS_PATH` (path to `scripts/deployments/local.json`)
- `HARDFORK_MNEMONIC` (12-word mnemonic for Hardhat accounts)
- `DATABASE_URL` (set automatically in Docker, required for local Postgres testing)
- `ADMIN_PRIVATE_KEY` (optional signer for admin mutations)

When running via Docker Compose, most values are provided in `docker-compose.yml`.

## Commands

- `npm run dev` – start the server with live reload (`tsx watch`)
- `npm run build` – compile TypeScript to `dist`
- `npm run start` – run compiled server

## Docker

The stack can be launched via Docker Compose:

```
cd graph
docker compose up --build
```

Services:

- `postgres`: Postgres 16 with persistent volume `postgres_data`.
- `hardhat`: Hardhat local node exposing `8545`.
- `graphql`: Builds the API container, runs `npm run start` on port `4000`.
- `indexer`: Same image running `npm run indexer`.

Hardhat artifacts and deployment JSON are mounted from the host project (`../artifacts`, `../scripts/deployments`).

### Migrations

Before starting the API/indexer, apply Prisma migrations:

```
docker compose run --rm graphql npm run prisma:migrate
```

This will create/update the schema in the Postgres container. After that, bring up the stack normally.

