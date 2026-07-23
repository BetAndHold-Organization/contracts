# E2E Setup: Crash Game on Arbitrum Sepolia

Guia paso a paso para levantar el Crash Game completo (3 servicios + frontend) contra Arbitrum Sepolia.

## Arquitectura

```
Browser (localhost:5173)
    |
    |-- SIWE auth ------------> authServer (localhost:3001) --> Redis
    |
    |-- EIP-712 signed bets --> operatorsServer (localhost:3002) --> on-chain multicallTry
    |
    +-- WebSocket ------------> crash backend (localhost:3003) --> PostgreSQL
                                    |
                                    +-- watches BetPlaced events on-chain
```

### Flujo de autenticacion
1. Wallet connect en el browser
2. Frontend -> authServer: `POST /auth/challenge` (obtiene SIWE message)
3. Wallet firma el SIWE message
4. Frontend -> authServer: `POST /auth/verify` (obtiene JWT access + refresh tokens)
5. Frontend -> crash backend: WS message `authenticate_jwt` con el access token
6. Auto-refresh del JWT antes de que expire

### Flujo de bet
1. Session key autorizada en AuthHub (one-time MetaMask tx)
2. EVA aprobada al **PaymentHandler** (one-time MetaMask tx) — NO al CrashGame directamente
3. Frontend lee `actionNonces(player)` del contrato CrashGame on-chain
4. Frontend firma EIP-712 `PlaceBet` con la session key (en localStorage, sin MetaMask)
5. Frontend -> operatorsServer: `POST /bet/crash/placeBet` con JWT + signature
6. operatorsServer ejecuta `multicallTry` on-chain
7. Crash backend detecta evento `BetPlaced` on-chain -> broadcast `player_bet` via WS
8. Frontend recibe el broadcast y actualiza UI

### Flujo de cashout
1. Frontend -> crash backend: WS message `cashout_intent` (autenticado via JWT session)
2. Backend procesa el cashout on-chain
3. Backend broadcast `player_cashout` via WS

## Prerequisitos

- Node.js 18+
- Docker (para Redis)
- PostgreSQL (para crash backend)
- Wallet con Sepolia ETH ([faucet](https://faucet.quicknode.com/arbitrum/sepolia))
- WalletConnect project ID (obtener en [cloud.walletconnect.com](https://cloud.walletconnect.com))
- VRF subscription fondeada con LINK en [vrf.chain.link](https://vrf.chain.link) (solo si hay que re-deployar contratos)

## Repositorios necesarios

| Repo | Rama | Descripcion |
|------|------|-------------|
| `betandhold` (este meta-repo) | `main` | Contratos, authServer, operatorsServer |
| `eva-train-crash-game` | `feature/platform-migration` | Crash backend (round lifecycle, WS, cashout) |
| `eva-train-crash-frontend` | `feature/platform-migration` | Frontend React |

---

## Paso 1: Clonar repos

```bash
git clone --recurse-submodules https://github.com/BetAndHold-Organization/betandhold.git
git clone https://github.com/devervalue/eva-train-crash-game.git
git clone https://github.com/devervalue/eva-train-crash-frontend.git

cd eva-train-crash-game && git checkout feature/platform-migration && cd ..
cd eva-train-crash-frontend && git checkout feature/platform-migration && cd ..
```

## Paso 2: Instalar dependencias

```bash
cd betandhold/backends/authServer && npm install && cd ../..
cd backends/operatorsServer && npm install && cd ../..
cd contracts && npm install && cd ..

cd ../eva-train-crash-game && npm install
cd ../eva-train-crash-frontend && npm install
```

## Paso 3: Deploy de contratos (solo primera vez)

Si los contratos ya estan deployados, saltar a Paso 4. Addresses actuales:

| Contrato | Address |
|----------|---------|
| CrashGame | `0xec00af8443b7781ccc1767ac1221eed7a7c4f3f4` |
| EVA Token | `0xf813ee99f010f87b0038fc215e58eece3de6aae3` |
| AuthHub | `0x6c7bfb77a47c8a9b5e1d21533b21b7034061d5dd` |
| PaymentHandler | `0x4b801d0e4d13423f57138b18e014b4faeea892e3` |
| RandomProvider | ver `deployments/arbitrumSepolia.json` |
| MultiLevelReferral | ver `deployments/arbitrumSepolia.json` |

Para re-deployar:

```bash
cd betandhold/contracts

# Crear .env:
# DEPLOYER_PRIVATE_KEY=0x...
# TESTNET_SEED=<mnemonic — generar con: cd ../backends/operatorsServer && npm run generate-test-seed>
# ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc
# VRF_COORDINATOR=0x5ce8d5a2bc84beb22a398cca51996f7930313d61
# VRF_KEY_HASH=0x1770bdc7eec7771f7ba4ffd640f34260d7f095b79c92d34a5b2551d6f6cfd2be
# VRF_SUBSCRIPTION_ID=<tu subscription ID de vrf.chain.link>

npx hardhat run scripts/testnet/deploy.ts --network arbitrumSepolia
```

Genera `deployments/arbitrumSepolia.json` con todas las addresses.

Despues del deploy, agregar manualmente los VRF consumers (RandomProvider + TicketLottery) en [vrf.chain.link](https://vrf.chain.link). El script imprime las addresses que hay que agregar.

## Paso 3b: Fondear wallets de test y registrar operators

```bash
cd betandhold

# Registra las wallets derivadas de TESTNET_SEED como operators en AuthHub
# y las fondea con ETH + EVA
npm run setup:operators

# Fondea wallets de jugadores de prueba con ETH + EVA + approvals
npm run setup:test-players
```

Tambien se puede fondear wallets manualmente: el deployer tiene todos los EVA tokens (supply total), transferir con MetaMask o script. El jugador necesita:
- Sepolia ETH para gas (obtener de faucet)
- EVA tokens (transferir desde deployer)
- Approval de EVA al **PaymentHandler** (no al CrashGame)

## Paso 4: Configurar authServer

```bash
cd betandhold/backends/authServer

# Generar JWT signing key
npm run generate-key

# Crear .env
cat > .env << 'ENV'
JWT_ISSUER=http://localhost:3001
SIWE_DOMAIN=localhost:5173
SIWE_URI=http://localhost:5173
SIWE_CHAIN_ID=421614
REDIS_URL=redis://localhost:6379
SIGNING_KEY_PATH=./keys/active.pem
ENV

# Levantar Redis
docker run -d --name redis -p 6379:6379 redis:7-alpine
```

## Paso 5: Configurar operatorsServer

```bash
cd betandhold/backends/operatorsServer

# Copiar deployment file (si no se copio automaticamente en el deploy)
cp ../../contracts/deployments/arbitrumSepolia.json ./deployments/

# Crear .env
cat > .env << 'ENV'
AUTH_SERVER_URL=http://localhost:3001
CHAIN_ID=421614
DEPLOYMENT_FILE=./deployments/arbitrumSepolia.json
SECRET_SOURCE=env
OPERATOR_SEED_PHRASE=<el mismo TESTNET_SEED usado en el deploy>
RPC_URL=https://sepolia-rollup.arbitrum.io/rpc
OPERATOR_COUNT=4
ENV
```

Los operators deben estar registrados en AuthHub on-chain (ver Paso 3b).

## Paso 6: Configurar crash backend

```bash
cd eva-train-crash-game

# Crear/actualizar .env:
PORT=3003
AUTH_SERVER_URL=http://localhost:3001
DEPLOYMENT_FILE=/ruta/absoluta/a/betandhold/contracts/deployments/arbitrumSepolia.json
RPC_URL=https://sepolia-rollup.arbitrum.io/rpc
OPERATOR_PRIVATE_KEY=0x...    # wallet con gameOperator role en CrashGame
DATABASE_URL=postgresql://user:pass@localhost:5432/crash_game

# Crear/migrar la base de datos
npx prisma db push
```

**Importante**: La wallet de `OPERATOR_PRIVATE_KEY` debe tener el role `gameOperator` en CrashGame. Si es la misma wallet del deploy, ya lo tiene. Si es otra, hay que agregarla:
```solidity
// Desde la wallet admin del CrashGame:
crashGame.setGameOperator(operatorAddress, true)
```

El operator tambien necesita un bond depositado en CrashGame (el deploy script lo hace automaticamente para la wallet del deploy). Sin bond, `createRound` revierte.

## Paso 7: Configurar frontend

```bash
cd eva-train-crash-frontend

cat > .env << 'ENV'
VITE_CHAIN_ID=421614
VITE_WEBSOCKET_URL=ws://localhost:3003/ws
VITE_API_URL=http://localhost:3003
VITE_AUTH_SERVER_URL=http://localhost:3001
VITE_OPERATORS_SERVER_URL=http://localhost:3002
VITE_CRASH_GAME_SEPOLIA=0xec00af8443b7781ccc1767ac1221eed7a7c4f3f4
VITE_EVA_TOKEN_SEPOLIA=0xf813ee99f010f87b0038fc215e58eece3de6aae3
VITE_AUTH_HUB_SEPOLIA=0x6c7bfb77a47c8a9b5e1d21533b21b7034061d5dd
VITE_PAYMENT_HANDLER_SEPOLIA=0x4b801d0e4d13423f57138b18e014b4faeea892e3
VITE_WALLETCONNECT_PROJECT_ID=<tu project ID de cloud.walletconnect.com>
VITE_DEMO_FALLBACK=false
ENV
```

## Paso 8: Levantar todo (4 terminales)

```bash
# Terminal 1: authServer
cd betandhold/backends/authServer && npm run dev    # :3001

# Terminal 2: operatorsServer
cd betandhold/backends/operatorsServer && npm run dev    # :3002

# Terminal 3: crash backend
cd eva-train-crash-game/backend && npm run dev    # :3003

# Terminal 4: frontend
cd eva-train-crash-frontend && npm run dev    # :5173
```

## Paso 9: Test del flow

1. Abrir http://localhost:5173
2. Conectar wallet (MetaMask en Arbitrum Sepolia)
3. **Sign-In**: firma SIWE message -> JWT emitido automaticamente
4. **Autorizar Session Key**: 1 tx MetaMask (AuthHub.authorize) — esto permite firmar bets sin MetaMask
5. **Aprobar EVA**: 1 tx MetaMask (EVA.approve al PaymentHandler)
6. **Place bet**: elegir monto (0.10 - 1.00 EVA) -> firma EIP-712 local (sin popup) -> POST a operatorsServer
7. Ver animacion del tren y multiplicador subiendo
8. **Cash Out** antes de que crashee -> cashout_intent via WS
9. Verificar en "My Bets" que el payout es correcto

### Dual bets
Se pueden colocar hasta 2 bets por ronda. Cada una se cashea independientemente. El segundo bet se coloca con el segundo slot del BettingPanel.

---

## Troubleshooting

| Problema | Solucion |
|----------|----------|
| `InvalidAmount()` on-chain (selector 0x2c5211c6) | Monto debe estar entre 0.1 y 1 EVA (limites on-chain). Frontend usa MIN_BET=0.10, MAX_BET=1.00. |
| JWT expired | Cerrar sesion y re-hacer SIWE sign-in. El frontend tiene auto-refresh pero puede fallar si la tab estuvo inactiva mucho tiempo. |
| Session key not found | Revocar y re-autorizar en AuthHub. La session key se guarda en localStorage. |
| `InsufficientAllowance` | Re-aprobar EVA al **PaymentHandler** (no al CrashGame). El frontend deberia pedir approval automaticamente. |
| operatorsServer 401 | Verificar que el JWT es valido y que las operator wallets estan registradas en AuthHub (`authHub.isOperator(addr)` debe ser true). |
| WS no conecta | Verificar que crash backend corre en :3003 y `VITE_WEBSOCKET_URL=ws://localhost:3003/ws`. |
| Redis connection refused | Verificar Docker container de Redis: `docker ps` y `docker start redis`. |
| Nonce mismatch en bet | El frontend re-lee el nonce on-chain automaticamente y reintenta. Si persiste, esperar un bloque (~250ms en Arbitrum). |
| Bet placed pero no aparece en UI | Verificar que crash backend esta escuchando eventos `BetPlaced` (log: "BetPlaced event detected"). El backend detecta el evento on-chain y lo broadcastea via WS. |
| `createRound` revierte | El operator necesita bond depositado >= `operatorBondAmount` (10 EVA). Verificar con `crashGame.bonds(operatorAddress)`. |
| Prisma error al arrancar backend | Correr `npx prisma db push` para sincronizar el schema con la DB. |
| Cashout no funciona | Verificar que el WS esta autenticado (JWT valido). El cashout va por WS, no por HTTP. |

---

## Notas tecnicas importantes (descubiertas durante E2E)

### EVA approve target
El frontend aprueba EVA al **PaymentHandler**, NO al CrashGame. PaymentHandler es el contrato que hace `transferFrom` cuando se coloca un bet. Si se aprueba al CrashGame, el bet falla con `InsufficientAllowance`.

### Addresses truncadas en WebSocket
El crash backend broadcastea `playerAddress` como `0x1234...5678` (truncado) por privacidad. El frontend necesita matchear con la address completa de la wallet conectada comparando prefix + suffix. Esto se hace en el handler de `player_bet` en `useWebSocket.ts`.

### actionNonces vs getBetNonce
El nuevo contrato usa `actionNonces(address player)` en vez de `getBetNonce`. Los nonces son globales por player, no por juego. El frontend lee esto antes de cada bet para construir el EIP-712 message.

### EIP-712 PlaceBet typehash
El typehash incluye `address game` como primer campo:
```
PlaceBet(address game, address player, uint256 amount, uint32 autoCashoutMultiplier, address referrer, uint256 nonce, uint256 deadline)
```

### Dual bet slots
El store usa `currentBets: [Bet | null, Bet | null]` para trackear los 2 bets del jugador. El handler de `player_bet` en el WS detecta si el bet es del jugador conectado y lo asigna al primer slot libre. Cada bet se cashea de forma independiente.

### gameOperator vs AuthHub operator
Son roles independientes:
- **gameOperator** (en CrashGame): Wallet que corre el backend para lifecycle (createRound, startRound, revealSeed, etc.). Necesita bond depositado.
- **AuthHub operator** (en AuthHub): Wallets del operatorsServer que ejecutan `multicallTry` para relay de bets. No necesitan bond.

### CrashGame multiplier convention
El CrashGame usa basis points de 4 decimales:
- `10_000` = 1.0000x
- `1_000_000` = 100.0000x
- `5_000_000` = 500.0000x

### House edge total
`getTotalEdgeBps()` = house (2%) + referral (2%) + jackpot (1%) = 5% total. Esto ya esta reflejado en los crash point calculations on-chain.

---

## Config on-chain (CrashGame)

| Parametro | Valor |
|-----------|-------|
| minBetAmount | 0.1 EVA |
| maxBetAmount | 1 EVA |
| maxPayoutPerRound | 100 EVA |
| maxMultiplier | 100.00x (1,000,000 bps) |
| operatorBondAmount | 10 EVA |
| houseBps | 200 (2%) |
| referralBps | 200 (2%) |
| jackpotBps | 100 (1%) |
| totalEdgeBps | 500 (5%) |
