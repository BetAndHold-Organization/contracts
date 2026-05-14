# Guía Completa de Deploy — Plinko Mainnet (Arbitrum One)

> **Referencia de configuración:** `docs/mainnet-configuration-guide.md`  
> **Red:** Arbitrum One  
> **Bankroll inicial:** 100 EVA  
> **House edge:** 1.5% + 1.5% referidos  
> **RTP:** ~96% (autosustentable: +~1% por apuesta al bankroll)

---

## Prerrequisitos

### Herramientas
```bash
node --version    # 18+ requerido
npm --version     # 9+ requerido
forge --version   # Foundry instalado → https://getfoundry.sh
git --version
```

### Infraestructura EVA ya desplegada — V5 (tener las direcciones listas)

| Contrato | Dirección |
|---|---|
| `EVA Token` (ERC-20) | `0x45D9831d8751B2325f3DBf48db748723726e1C8c` |
| `PaymentHandler` | `0xabe66fc056dd0e116b90201e487ea102fd7df1ba` |
| `RandomProviderV2` | `0x6513baa6c53a570ec899bb1504a95f160b8d7850` |
| `MultiLevelReferral` | `0xf359892154589e9459c6f979d5de37a2755cf0e9` |
| `ProgressiveJackpotV2` | `0xb8dbb7d52be61fc30b7f47e11ddb9af472c6a2ef` |
| `House wallet` | `0x2132c5e539F1Da6090424644576ABB5C5aDcdbbd` |

### Wallets necesarias

| Wallet | Propósito | Saldo mínimo |
|---|---|---|
| **Deployer** | Deploy + configuración del contrato | ~0.01 ETH (gas) + 100 EVA (bankroll) |
| **House wallet** (`feeRecipient`) | Recibe el 1.5% de house edge por apuesta | — |

---

## PARTE 1: Deploy del Contrato Plinko

### 1.1 Preparar el entorno

```bash
cd plinko-smart-contracts
npm install
```

### 1.2 Configurar variables de entorno

Crear o editar el archivo `.env`:

```bash
# ─── RPC ──────────────────────────────────────────────────────────────────────
MAINNET_ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc   # o tu RPC privado (Alchemy/Infura)

# ─── Deployer (NUNCA subir al repo) ──────────────────────────────────────────
MAINNET_DEPLOYER_PRIVATE_KEY=0x...   # Private key del deployer

# ─── Verificación en Arbiscan (opcional pero recomendado) ────────────────────
MAINNET_ARBISCAN_API_KEY=...

# ─── Fondeo (100 EVA default, set "0" to skip) ───────────────────────────────
PLINKO_FUND_AMOUNT=100
```

> Las direcciones de infraestructura V5 (PaymentHandler, RandomProviderV2, EVA Token, House wallet) están hardcodeadas en el script `deploy-plinko-v5.ts` — no es necesario configurarlas en `.env`.

> ⚠️ **Seguridad:** Asegúrate de que `.env` esté en `.gitignore`. Nunca subas private keys.

---

### 1.3 Deploy completo con un solo script

El script `deploy-plinko-v5.ts` ejecuta todos los pasos de forma automática:
deploy + multiplicadores + configuración + registros + fondeo + verificación Arbiscan.

```bash
npx hardhat run scripts/mainnet/deploy-plinko-v5.ts --network arbitrum
```

**Lo que hace el script (en orden):**
1. Deploys Plinko contract (`Plinko(handler, random, token, 0, 0)`)
2. Sets 15 multiplier tables (RTP ~96%, patrón estrictamente decreciente)
3. Configures: `setAllowedRows`, `setBetLimits`, `setMaxDropsPerBet`, pending limits, expiry
4. Registers in PaymentHandler (1.5% house + 1.5% referral, payoutTarget = self)
5. Registers in RandomProviderV2 as consumer (rangeLimit = 1)
6. Funds bankroll (100 EVA via direct transfer, configurable via `PLINKO_FUND_AMOUNT`)
7. Saves deployment to `scripts/mainnet/deployments/plinko-mainnet-v5.json`
8. Verifies contract on Arbiscan (auto-retry ×3)
9. Runs post-deploy verification checklist (reads all state on-chain)

**Salida esperada:**
```
══════════════════════════════════════════════════════════════
  PLINKO DEPLOYMENT — ARBITRUM MAINNET (V5 Infrastructure)
══════════════════════════════════════════════════════════════

1. Deploying Plinko...
   Plinko deployed: 0xNUEVA_DIRECCION_PLINKO

2. Setting multiplier tables (15 tables, RTP ~96%)...
   8 rows, Low risk: set
   ...
   16 rows, High risk: set
   All 15 multiplier tables configured

3. Configuring game parameters...
4. Registering Plinko in PaymentHandler...
5. Registering Plinko in RandomProviderV2...
6. Funding bankroll with 100.0 EVA...
   ✓ Bankroll funded correctly

9. Running post-deploy verification...
   ✓  minBet == 0.1 EVA
   ✓  maxBet == 5 EVA
   ✓  handler: payoutTarget == plinko
   ...
   All checks passed ✓
```

> El script guarda la dirección y toda la config en `scripts/mainnet/deployments/plinko-mainnet-v5.json`.
> La verificación en Arbiscan es automática (constructor args: handler, random, token, 0, 0).

---

### 1.4 Checklist de verificación post-deploy del contrato

> El script `deploy-plinko-v5.ts` ejecuta todas estas verificaciones automáticamente en el paso 9.
> Si necesitas verificar manualmente, puedes revisar en Arbiscan:

```solidity
// Estado esperado tras el deploy completo:

plinko.minBet()                    == 0.1 EVA (100000000000000000)
plinko.maxBet()                    == 5.0 EVA (5000000000000000000)
plinko.maxDropsPerBet()            == 10
plinko.paused()                    == false
plinko.availableLiquidity()        == 100 EVA
plinko.allowedRows(8)              == true
plinko.allowedRows(16)             == true
plinko.maxPendingBetsPerPlayer()   == 5
plinko.maxTotalPendingBets()       == 30
plinko.betExpiryBlocks()           == 3600

// PaymentHandler (0xabe66fc056dd0e116b90201e487ea102fd7df1ba):
paymentHandler.getGameConfig(plinko):
  enabled       == true
  payoutTarget  == address(plinko)   ← CRÍTICO: debe ser el propio Plinko
  houseEdgeBps  == 150
  referralBps   == 150

// Multiplicadores (ejemplo):
plinko.getMultipliers(8, 0)[4]     == 39    // 8-Low centro = 0.39x
plinko.getMultipliers(16, 2)[8]    == 12    // 16-High centro = 0.12x
```

---

## PARTE 2: Deploy del Frontend

### Arquitectura real

El frontend **NO usa Amplify**. El pipeline está en GitHub Actions y despliega a **AWS S3 + CloudFront**:

```
Push a branch main
        │
        ▼
GitHub Actions (.github/workflows/build-and-deploy.yml)
        │
        ├─ 1. npm ci
        ├─ 2. Crea .env desde GitHub Secrets
        ├─ 3. npm run build → dist/
        ├─ 4. aws s3 sync dist/ → s3://BUCKET/eva-plinko/
        │      ├─ assets hashed → cache 1 año (immutable)
        │      └─ remoteEntry.js → no-cache (MF manifest, siempre fresco)
        ├─ 5. Actualiza registry.json en la raíz del bucket
        │      (la shell B&H lee este archivo para descubrir los juegos)
        └─ 6. Invalida CloudFront → /eva-plinko/assets/* + /registry.json
```

> El deploy es **completamente automático** con cada push a `main`. No hay pasos manuales.

---

### 2.1 Configurar los GitHub Secrets del repositorio

Ir a: **Repositorio plinko-frontend → Settings → Secrets and variables → Actions**

#### Secrets obligatorios

| Secret | Descripción | Valor mainnet |
|---|---|---|
| `VITE_NETWORK` | Red objetivo | `mainnet` |
| `VITE_PLINKO_CONTRACT_ADDRESS` | Dirección del contrato Plinko (del paso 1.3) | `0xDIRECCION_PLINKO` |
| `VITE_PAYMENT_HANDLER_ADDRESS` | PaymentHandler | `0xabe66fc056dd0e116b90201e487ea102fd7df1ba` |
| `VITE_EVA_TOKEN_ADDRESS` | EVA Token | `0x45D9831d8751B2325f3DBf48db748723726e1C8c` |
| `VITE_API_BASE_URL` | URL del backend API | `https://api.betandhold.com` |
| `CDN_BASE_URL` | URL base de CloudFront **sin trailing slash** | `https://cdn.betandhold.com` |
| `AWS_ACCESS_KEY_ID` | Credencial AWS | `AKIA...` |
| `AWS_SECRET_ACCESS_KEY` | Credencial AWS | `xxxx...` |
| `AWS_REGION` | Región del bucket S3 | `us-east-1` |
| `S3_GAMES_BUCKET` | Nombre del bucket compartido de juegos | `bh-games-prod` |
| `CLOUDFRONT_DISTRIBUTION_ID` | ID de la distribución CloudFront | `EXXXXXXXXXXXXXX` |

#### Secrets opcionales (recomendados en producción)

| Secret | Descripción | Notas |
|---|---|---|
| `VITE_WALLET_CONNECT_PROJECT_ID` | WalletConnect Cloud project ID | Obtener en [cloud.walletconnect.com](https://cloud.walletconnect.com). Sin este secret se usa un ID de fallback compartido que puede tener rate limits. |
| `VITE_ARBITRUM_RPC_URL` | URL de un RPC privado de Arbitrum One | Recomendado para evitar rate limits del RPC público. Obtener en [alchemy.com](https://alchemy.com) o [infura.io](https://infura.io). Si no se configura el pipeline usa `https://arb1.arbitrum.io/rpc`. |
| `VITE_MAINTENANCE_MODE` | `true` para mostrar pantalla de mantenimiento | Por defecto `false`. Cambiar a `true` + push para activar mantenimiento sin code changes. |

> ⚠️ **Nota sobre `CDN_BASE_URL`:** Solo la URL base sin path (ej: `https://cdn.betandhold.com`). El pipeline añade automáticamente `/eva-plinko` al construir el `remoteEntry.js` y el `registry.json`.

---

### 2.2 Hacer el deploy

```bash
# Simplemente hacer push a main:
git push origin main
```

El workflow `.github/workflows/build-and-deploy.yml` se dispara automáticamente.

**También se puede disparar manualmente:**
```
Repositorio → Actions → "Build and Deploy Plinko (MF Remote)" → Run workflow
```

---

### 2.3 Salida esperada del pipeline

```
✅ Plinko deployed successfully
   Bucket   : s3://bh-games-prod/eva-plinko/
   Registry : s3://bh-games-prod/registry.json
   Region   : us-east-1
   Dist ID  : EXXXXXXXXXXXXXX

   remoteEntry → https://cdn.betandhold.com/eva-plinko/assets/remoteEntry.js
   registry   → https://cdn.betandhold.com/registry.json
```

---

### 2.4 Qué hace el pipeline con la Shell B&H

El paso más importante del pipeline es la actualización del `registry.json`. La shell B&H lee ese archivo para saber qué juegos están disponibles. El entry que se registra automáticamente es:

```json
{
  "id":             "eva_plinko",
  "label":          "Plinko",
  "thumbnailUrl":   "/portada-plinko.png",
  "launchUrl":      "https://cdn.betandhold.com/eva-plinko",
  "category":       "casual",
  "isPopular":      true,
  "sections":       ["popular"],
  "launchMode":     "microfrontend",
  "remoteName":     "eva_plinko",
  "remoteEntry":    "https://cdn.betandhold.com/eva-plinko/assets/remoteEntry.js",
  "exposedModule":  "./Game",
  "renderMode":     "federation"
}
```

> El pipeline hace un **upsert** — si `eva_plinko` ya existe en el registry lo reemplaza, si no existe lo añade. Nunca elimina otros juegos.

> **Thumbnail del juego (`portada-plinko.png`):** El `registry.json` referencia `"thumbnailUrl": "/portada-plinko.png"`. Esta ruta es relativa a la raíz del CloudFront. La forma correcta de gestionarla es **agregar el archivo en el `public/` del proyecto B&H Shell** — el pipeline del shell lo subirá automáticamente a `s3://BUCKET/portada-plinko.png`. No es necesario subirlo manualmente desde aquí.
>
> Si por algún motivo el shell despliega en un subfolder (no en la raíz del bucket), actualiza el campo `thumbnailUrl` en el paso "Update games registry" del pipeline para usar la URL absoluta correcta.

---

### 2.5 Estrategia de caché en S3/CloudFront

| Archivo | Cache-Control | Razón |
|---|---|---|
| `assets/index-[hash].js` | `public, max-age=31536000, immutable` | El hash cambia con cada build → seguro cachear 1 año |
| `assets/index-[hash].css` | `public, max-age=31536000, immutable` | Igual |
| `assets/remoteEntry.js` | `no-cache, no-store, must-revalidate` | Es el manifiesto de Module Federation — la shell siempre debe leer la versión más nueva |
| `registry.json` | `no-cache, no-store, must-revalidate` | La shell lo lee al arrancar para descubrir juegos |

---

## PARTE 3: Verificación End-to-End

### 3.1 Checklist completo de verificación

```
CONTRATO
  ✅ Plinko desplegado y verificado en Arbiscan
  ✅ availableLiquidity() == 100 EVA
  ✅ PaymentHandler registrado (houseEdgeBps=150, referralBps=150)
  ✅ payoutTarget == address(plinko)   ← CRÍTICO
  ✅ RandomProvider registrado como consumer
  ✅ 15 tablas de multiplicadores cargadas
  ✅ minBet=0.1 EVA, maxBet=5 EVA, maxDropsPerBet=10
  ✅ allowedRows: [8, 10, 12, 14, 16]
  ✅ paused == false

FRONTEND
  ✅ Build de producción sin errores
  ✅ remoteEntry.js accesible en la URL pública
  ✅ Variables de entorno correctas (VITE_PLINKO_CONTRACT_ADDRESS apunta al contrato mainnet)
  ✅ Conectar wallet en Arbitrum One → sin errores de red
  ✅ El frontend lee los multiplicadores del contrato (no los fallback locales)

PRUEBA FUNCIONAL
  ✅ Realizar una apuesta de prueba con 0.1 EVA (mínimo)
  ✅ VRF responde (la bola cae) dentro de ~30 segundos
  ✅ El pago se acredita correctamente
  ✅ availableLiquidity() se actualiza después de la apuesta
```

### 3.2 Prueba de apuesta mínima en mainnet

```
1. Conectar wallet (Arbitrum One)
2. Seleccionar: 8 rows, Low risk
3. Apuesta: 0.1 EVA, 1 drop
4. Click "Play"
5. Aprobar el gasto de EVA (approve ERC-20)
6. Confirmar la transacción
7. Esperar resolución VRF (~30 segundos en Arbitrum)
8. Verificar que se anima la caída y se muestra el pago
```

---

## PARTE 4: Referencia Rápida de Parámetros Finales

| Parámetro | Valor |
|---|---|
| **Red** | Arbitrum One (chainId: 42161) |
| **Bankroll inicial** | **100 EVA** |
| **EVA Token** | `0x45D9831d8751B2325f3DBf48db748723726e1C8c` |
| **PaymentHandler** | `0xabe66fc056dd0e116b90201e487ea102fd7df1ba` |
| **RandomProviderV2** | `0x6513baa6c53a570ec899bb1504a95f160b8d7850` |
| **houseEdgeBps** | **150** (1.5% → feeRecipient) |
| **referralBps** | **150** (1.5% → referral contract) |
| **RTP multiplicadores** | **~96%** (estrictamente decreciente borde→centro) |
| **Net al bankroll por wager** | **~+1%** ✅ autosustentable |
| **minBet** | **0.1 EVA** |
| **maxBet** | **5 EVA** |
| **maxDropsPerBet** | **10** |
| **maxPendingBetsPerPlayer** | **5** |
| **maxTotalPendingBets** | **30** |
| **betExpiryBlocks** | **3600** (~15 min en Arbitrum) |
| **allowedRows** | **8, 10, 12, 14, 16** |

---

## PARTE 5: Operación y Mantenimiento

### Monitorear el bankroll

```bash
# Desde cualquier cliente RPC (ethers/viem) o Arbiscan:
plinko.availableLiquidity()   # Liquidez disponible
plinko.lockedExposure()       # EVA bloqueado en apuestas pendientes
```

### Agregar más fondos al bankroll

```bash
# En .env:
PLINKO_CONTRACT_ADDRESS=0xDIRECCION_PLINKO
FUND_AMOUNT_EVA=50   # Cantidad adicional a depositar

npx hardhat run scripts/mainnet/fund-plinko.ts --network arbitrum
```

### Pausar el juego (mantenimiento)

```solidity
plinko.setPaused(true)    // Nuevas apuestas bloqueadas, settlements en proceso continúan
plinko.setPaused(false)   // Reactivar
```

### Activar modo mantenimiento en el frontend

Cambiar el secret de GitHub y hacer push:

```
Repositorio plinko-frontend → Settings → Secrets → Actions
  → VITE_MAINTENANCE_MODE = true
```

Luego triggear el pipeline manualmente:
```
Repositorio → Actions → "Build and Deploy Plinko (MF Remote)" → Run workflow
```

Para desactivar, volver a poner `VITE_MAINTENANCE_MODE = false` y re-deployar.

### Retiro de emergencia

```solidity
// Solo el owner puede ejecutar esto
plinko.emergencyWithdraw(destinatario, cantidad)
```

> ⚠️ Solo usar en caso de emergencia. Asegurarse de que no haya `lockedExposure > 0` antes de retirar.

---

## PARTE 6: Orden de Ejecución (Resumen)

```
CONTRATOS (TheBurningGames_HHv3/)
 ─────────────────────────────────
  1. Editar .env con RPC URL y deployer private key
  2. npm install
  3. npx hardhat run scripts/mainnet/deploy-plinko-v5.ts --network arbitrum
     → Deploy + multipliers + config + register + fund (100 EVA)
     → Genera: scripts/mainnet/deployments/plinko-mainnet-v5.json
     → Verifica en Arbiscan automáticamente
     → Ejecuta checklist de verificación on-chain
  4. Verificar output: "All checks passed ✓"

FRONTEND (plinko-frontend/)
 ───────────────────────────
  9.  Ir a GitHub → Settings → Secrets → Actions
  10. Añadir / actualizar los secrets:
        OBLIGATORIOS:
          VITE_NETWORK=mainnet
          VITE_PLINKO_CONTRACT_ADDRESS=0xDIRECCION_PLINKO
          VITE_PAYMENT_HANDLER_ADDRESS=0xabe66fc056dd0e116b90201e487ea102fd7df1ba
          VITE_EVA_TOKEN_ADDRESS=0x45D9831d8751B2325f3DBf48db748723726e1C8c
          VITE_API_BASE_URL, CDN_BASE_URL, AWS_*, S3_GAMES_BUCKET, CLOUDFRONT_*
        OPCIONALES (recomendados):
          VITE_WALLET_CONNECT_PROJECT_ID  → WalletConnect Cloud
          VITE_ARBITRUM_RPC_URL           → RPC privado Arbitrum (Alchemy/Infura)
  11. Agregar `portada-plinko.png` al `public/` del proyecto B&H Shell (el pipeline del shell lo sube al bucket automáticamente)
  12. git push origin main  →  el pipeline se dispara automáticamente
  13. Verificar en GitHub Actions que el workflow completa sin errores
  14. Confirmar que registry.json en S3 tiene el entry "eva_plinko" con URL mainnet
  15. Prueba funcional end-to-end con 0.1 EVA en la shell B&H
```
