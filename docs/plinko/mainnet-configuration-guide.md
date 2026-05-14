# Guía de Configuración Mainnet — Plinko Contract

> **Fecha:** Abril 2026
> **Contrato:** `Plinko.sol` · `MULTIPLIER_SCALE = 100`
> **Bankroll inicial:** 100 EVA
> **Fees PaymentHandler:** houseEdge 1.5% + referral 1.5% = 3% total
> **Estado:** Autosustentable · +1% de crecimiento neto por cada EVA apostada

---

## Índice

1. [Variables del contrato](#1-variables-del-contrato)
2. [Modelo de negocio y sostenibilidad](#2-modelo-de-negocio-y-sostenibilidad)
3. [Tablas de multiplicadores — RTP 96%](#3-tablas-de-multiplicadores--rtp-96)
4. [Verificación matemática del RTP](#4-verificación-matemática-del-rtp)
5. [Análisis de liquidez con 100 EVA](#5-análisis-de-liquidez-con-100-eva)
6. [Configuración completa para mainnet](#6-configuración-completa-para-mainnet)
7. [Secuencia de deploy](#7-secuencia-de-deploy)
8. [Aviso crítico: escala de multiplicadores](#8-aviso-crítico-escala-de-multiplicadores)

---

## 1. Variables del Contrato

### 1.1 Constantes (no modificables post-deploy)

| Variable | Valor | Significado |
|---|---|---|
| `MULTIPLIER_SCALE` | `100` | Factor de escala. `560` almacenado = `5.60x` real. |
| `MIN_ROWS` | `4` | Mínimo de filas permitidas. |
| `MAX_ROWS` | `32` | Máximo de filas permitidas. |
| `MAX_DROPS` | `100` | Tope absoluto de bolas por apuesta (hard-coded). |
| `MAX_PENDING_BETS_PER_PLAYER_CAP` | `10` | Techo máximo para `maxPendingBetsPerPlayer`. |

---

### 1.2 Variables configurables por el owner

#### `paused` — Estado de pausa
- **Tipo:** `bool` · Default: `false`
- **Función:** `true` bloquea `placeBet()` con `GamePaused()`. Las liquidaciones en curso siguen procesándose.
- **Setter:** `setPaused(bool _paused)`
- **Cuándo usarlo:** Antes de actualizar multiplicadores o en emergencias.

---

#### `minBet` — Apuesta mínima total
- **Tipo:** `uint256` · Unidades: wei (18 decimales EVA)
- **Función:** Límite inferior del `totalWager` por transacción (`betAmount × numDrops`). Si es `0`, no hay límite mínimo.
- **Setter:** `setBetLimits(uint256 _minBet, uint256 _maxBet)`
- **Config mainnet:** `0.1 ether` (0.1 EVA). Con 100 EVA bankroll, funciona para **todas** las configs incluyendo 16-High.

---

#### `maxBet` — Apuesta máxima total
- **Tipo:** `uint256` · Unidades: wei
- **Función:** Techo del `totalWager`. Siempre existe además un segundo límite dinámico: el contrato bloquea si `maxPayout > availableLiquidity()`. Aplica el que sea menor.
- **Setter:** `setBetLimits(uint256 _minBet, uint256 _maxBet)`
- **Config mainnet:** `5 ether` (5 EVA). Limita las configs de bajo multiplicador; las de alto multiplicador quedan limitadas por la liquidez de todas formas.

---

#### `maxDropsPerBet` — Máximo de bolas por apuesta
- **Tipo:** `uint8` · Default: `10` · Rango: 1–100
- **Función:** Controla cuántas bolas puede lanzar un jugador en una sola transacción. El `maxPayout` escala linealmente con este valor.
- **Setter:** `setMaxDropsPerBet(uint8 _maxDrops)`
- **Config mainnet:** `10`

---

#### `allowedRows` / `allowedRowsList` — Filas habilitadas
- **Tipo:** `mapping(uint8 => bool)` + `uint8[]`
- **Función:** Solo filas presentes aquí son válidas en `placeBet()`. Intentar usar otra revierte con `RowsNotAllowed`.
- **Setter:** `setAllowedRows(uint8[] calldata rows)`
- **Config mainnet:** `[8, 10, 12, 14, 16]` — Con 100 EVA todas las filas son viables.

---

#### `betExpiryBlocks` — Expiración de apuestas pendientes
- **Tipo:** `uint256` · Default: `86_400` bloques (~6 horas en Arbitrum)
- **Función:** Bloques que deben transcurrir sin respuesta VRF para que el owner pueda cancelar manualmente con `cancelExpiredBet()`. Protege contra bets bloqueadas si el VRF falla.
- **Setter:** `setBetExpiryBlocks(uint256 _blocks)`
- **Config mainnet:** `3600` bloques (~15 minutos en Arbitrum a ~250 ms/bloque).

---

#### `maxPendingBetsPerPlayer` — Máx. bets pendientes por wallet
- **Tipo:** `uint8` · Default: `5` · Máximo configurable: `10`
- **Función:** Limita cuántas apuestas simultáneas sin resolver puede tener un mismo jugador. Evita que una wallet bloquee toda la liquidez.
- **Setter:** `setMaxPendingBetsPerPlayer(uint8 _limit)`
- **Config mainnet:** `5`

---

#### `maxTotalPendingBets` — Máx. bets pendientes en el sistema
- **Tipo:** `uint256` · Default: `50`
- **Función:** Límite global de apuestas no resueltas entre **todos** los jugadores. Protege contra ataques de "liquidity squeeze" multi-wallet donde múltiples wallets bloquean simultáneamente toda la liquidez disponible.
- **Setter:** `setMaxTotalPendingBets(uint256 _limit)`
- **Config mainnet:** `30`

---

### 1.3 Variables de estado (auto-gestionadas, solo lectura)

| Variable | Descripción |
|---|---|
| `lockedExposure` | Suma de los `maxPayout` de todas las bets pendientes. Sube en `placeBet`, baja en `fulfillRandomness` / `handleRandomFailure` / `cancelExpiredBet`. |
| `totalPendingBets` | Contador global de apuestas sin resolver en el sistema. |
| `pendingBetCount[address]` | Bets pendientes por wallet individual. |
| `maxMultipliers[rows][risk]` | Cache del multiplicador máximo por config. Se actualiza automáticamente en `setMultipliers()`. |

---

### 1.4 Función clave: `availableLiquidity()`

```
availableLiquidity() = evaToken.balanceOf(address(plinko)) - lockedExposure
```

**Una apuesta se BLOQUEA si:**
```
betAmount × maxMultiplier_almacenado × numDrops / 100 > availableLiquidity()
```

Esto implica que el **máximo totalWager posible** para cualquier config es:
```
maxTotalWager = availableLiquidity() × 100 / maxMultiplier_almacenado
             = availableLiquidity() / maxMultiplier_float
```

---

## 2. Modelo de Negocio y Sostenibilidad

### 2.1 Flujo del dinero en cada apuesta

```
Jugador paga 1 EVA
        │
        ▼
Plinko recibe → envía al PaymentHandler
        │
        ├── houseEdge 1.5% (0.015 EVA) ──→ feeRecipient (wallet del operador)
        │
        ├── referralBps 1.5% (0.015 EVA) ─→ contrato de referidos
        │
        └── netAmount 97% (0.97 EVA) ─────→ Plinko contract (bankroll)

VRF resuelve → Plinko paga al jugador:
        payout = betAmount × multiplier / 100
        Esperado = 1 EVA × RTP = 1 × 0.96 = 0.96 EVA

Net del bankroll por apuesta:
        0.97 EVA recibido − 0.96 EVA pagado = +0.01 EVA → BANKROLL CRECE ✅
```

### 2.2 Por qué el RTP de los multiplicadores debe ser 96% (no 98%)

| Escenario | Net Plinko | Net bankroll | Estado |
|---|---|---|---|
| RTP = 98%, fees = 3% | 97% recibe, 98% paga | **−1% por bet** | ❌ Se drena |
| RTP = 97%, fees = 3% | 97% recibe, 97% paga | **0% por bet** | ⚠️ Break even |
| **RTP = 96%, fees = 3%** | **97% recibe, 96% paga** | **+1% por bet** | ✅ Crece |
| RTP = 95%, fees = 3% | 97% recibe, 95% paga | +2% por bet | ✅ Crece más rápido |

**RTP = 96% es el equilibrio óptimo:** el bankroll crece 1% por cada EVA apostada mientras el juego sigue siendo competitivo para el jugador.

### 2.3 Proyección de ingresos y crecimiento

| Métrica | Cálculo | Resultado |
|---|---|---|
| Fee para operador | 1.5% × wager | 0.015 EVA por cada EVA apostada |
| Crecimiento bankroll | 1% × wager | 0.010 EVA por cada EVA apostada |
| Con 200 bets/día a 0.5 EVA prom. | 200 × 0.5 × 0.015 | **1.5 EVA/día al operador** |
| Con 200 bets/día a 0.5 EVA prom. | 200 × 0.5 × 0.010 | **1.0 EVA/día al bankroll** |
| Bankroll en 30 días (bajo tráfico) | 100 + 30×1.0 | **~130 EVA** |

---

## 3. Tablas de Multiplicadores — RTP 96%

> **Escala:** `MULTIPLIER_SCALE = 100` → valor `560` representa `5.60x`
>
> **Regla de diseño:** Los multiplicadores decrecen **estrictamente** desde los extremos hacia el centro: `mult[0] > mult[1] > ... > mult[centro]`. El centro es siempre el valor mínimo. Los jackpots de borde permanecen igual. Para lograr esta monotonía con RTP=96%, los slots intermedios de algunas configs (12-Low, 14, 16) fueron redistribuidos. Las tablas mantienen simetría perfecta.

---

### 8 Rows — 9 slots (0 a 8)

```
Probabilidades × 256: [1, 8, 28, 56, 70, 56, 28, 8, 1]
Slot más probable: slot 4 (centro) con P = 70/256 = 27.34%

LOW RISK
  Almacenado: [560, 210, 110, 100, 39, 100, 110, 210, 560]
  Float (x):  [5.6, 2.1, 1.1, 1.0, 0.39, 1.0, 1.1, 2.1, 5.6]
  Max mult:   560 (5.6x)   RTP: 95.98%   House edge: 4.02% (mult) + neto: 96%−97% = +1%

MEDIUM RISK
  Almacenado: [1300, 300, 130, 70, 29, 70, 130, 300, 1300]
  Float (x):  [13, 3, 1.3, 0.7, 0.29, 0.7, 1.3, 3, 13]
  Max mult:   1300 (13x)   RTP: 95.90%   House edge efectivo: ~4.1%

HIGH RISK
  Almacenado: [1800, 560, 120, 40, 12, 40, 120, 560, 1800]
  Float (x):  [18, 5.6, 1.2, 0.4, 0.12, 0.4, 1.2, 5.6, 18]
  Max mult:   1800 (18x)   RTP: 96.09%   House edge efectivo: ~3.9%
```

---

### 10 Rows — 11 slots (0 a 10)

```
Probabilidades × 1024: [1, 10, 45, 120, 210, 252, 210, 120, 45, 10, 1]
Slot más probable: slot 5 (centro) con P = 252/1024 = 24.61%

LOW RISK
  Almacenado: [890, 300, 140, 110, 100, 38, 100, 110, 140, 300, 890]
  Float (x):  [8.9, 3.0, 1.4, 1.1, 1.0, 0.38, 1.0, 1.1, 1.4, 3.0, 8.9]
  Max mult:   890 (8.9x)   RTP: 96.05%

MEDIUM RISK
  Almacenado: [2200, 500, 200, 140, 60, 28, 60, 140, 200, 500, 2200]
  Float (x):  [22, 5, 2, 1.4, 0.6, 0.28, 0.6, 1.4, 2, 5, 22]
  Max mult:   2200 (22x)   RTP: 96.03%

HIGH RISK
  Almacenado: [7500, 990, 300, 90, 30, 9, 30, 90, 300, 990, 7500]
  Float (x):  [75, 9.9, 3, 0.9, 0.3, 0.09, 0.3, 0.9, 3, 9.9, 75]
  Max mult:   7500 (75x)   RTP: 95.97%
```

---

### 12 Rows — 13 slots (0 a 12)

```
Probabilidades × 4096: [1, 12, 66, 220, 495, 792, 924, 792, 495, 220, 66, 12, 1]
Slot más probable: slot 6 (centro) con P = 924/4096 = 22.56%

LOW RISK
  Almacenado: [750, 450, 280, 180, 110, 70, 49, 70, 110, 180, 280, 450, 750]
  Float (x):  [7.5, 4.5, 2.8, 1.8, 1.1, 0.7, 0.49, 0.7, 1.1, 1.8, 2.8, 4.5, 7.5]
  Orden:      7.5 > 4.5 > 2.8 > 1.8 > 1.1 > 0.7 > 0.49 ✓ estrictamente decreciente
  Max mult:   750 (7.5x)   RTP: 96.07%

MEDIUM RISK
  Almacenado: [3000, 700, 300, 160, 90, 70, 65, 70, 90, 160, 300, 700, 3000]
  Float (x):  [30, 7, 3, 1.6, 0.9, 0.7, 0.65, 0.7, 0.9, 1.6, 3, 7, 30]
  Orden:      30 > 7 > 3 > 1.6 > 0.9 > 0.7 > 0.65 ✓ estrictamente decreciente
  Max mult:   3000 (30x)   RTP: 95.91%

HIGH RISK  ← ajuste en slots intermedios y centro para monotonía
  Almacenado: [16800, 2400, 800, 200, 70, 15, 11, 15, 70, 200, 800, 2400, 16800]
  Float (x):  [168, 24, 8, 2, 0.7, 0.15, 0.11, 0.15, 0.7, 2, 8, 24, 168]
  Orden:      168 > 24 > 8 > 2 > 0.7 > 0.15 > 0.11 ✓ estrictamente decreciente
  Max mult:   16800 (168x)  RTP: 95.96%
```

> **Nota de diseño:** Todas las tablas siguen el principio de **decremento estricto desde borde al centro**. Para filas 12, 14 y 16 esto requirió redistribuir los slots intermedios (no solo el centro), manteniendo los jackpots de borde intactos y el RTP objetivo ~96%.

---

### 14 Rows — 15 slots (0 a 14)

```
Probabilidades × 16384: [1, 14, 91, 364, 1001, 2002, 3003, 3432, 3003, 2002, 1001, 364, 91, 14, 1]
Slot más probable: slot 7 (centro) con P = 3432/16384 = 20.95%

LOW RISK
  Almacenado: [910, 520, 240, 180, 130, 110, 85, 50, 85, 110, 130, 180, 240, 520, 910]
  Float (x):  [9.1, 5.2, 2.4, 1.8, 1.3, 1.1, 0.85, 0.50, 0.85, 1.1, 1.3, 1.8, 2.4, 5.2, 9.1]
  Orden:      9.1 > 5.2 > 2.4 > 1.8 > 1.3 > 1.1 > 0.85 > 0.50 ✓ estrictamente decreciente
  Max mult:   910 (9.1x)   RTP: 96.07%

MEDIUM RISK
  Almacenado: [5200, 1300, 430, 300, 150, 85, 65, 58, 65, 85, 150, 300, 430, 1300, 5200]
  Float (x):  [52, 13, 4.3, 3, 1.5, 0.85, 0.65, 0.58, 0.65, 0.85, 1.5, 3, 4.3, 13, 52]
  Orden:      52 > 13 > 4.3 > 3 > 1.5 > 0.85 > 0.65 > 0.58 ✓ estrictamente decreciente
  Max mult:   5200 (52x)   RTP: 96.04%

HIGH RISK
  Almacenado: [52400, 7000, 1500, 370, 160, 50, 30, 9, 30, 50, 160, 370, 1500, 7000, 52400]
  Float (x):  [524, 70, 15, 3.7, 1.6, 0.5, 0.30, 0.09, 0.30, 0.5, 1.6, 3.7, 15, 70, 524]
  Orden:      524 > 70 > 15 > 3.7 > 1.6 > 0.5 > 0.30 > 0.09 ✓ estrictamente decreciente
  Max mult:   52400 (524x)  RTP: 96.11%
```

---

### 16 Rows — 17 slots (0 a 16)

```
Probabilidades × 65536: [1,16,120,560,1820,4368,8008,11440,12870,11440,8008,4368,1820,560,120,16,1]
Slot más probable: slot 8 (centro) con P = 12870/65536 = 19.64%

LOW RISK
  Almacenado: [2000, 1100, 600, 350, 200, 130, 90, 80, 45, 80, 90, 130, 200, 350, 600, 1100, 2000]
  Float (x):  [20, 11, 6.0, 3.5, 2.0, 1.3, 0.9, 0.80, 0.45, 0.80, 0.9, 1.3, 2.0, 3.5, 6.0, 11, 20]
  Orden:      20 > 11 > 6.0 > 3.5 > 2.0 > 1.3 > 0.9 > 0.80 > 0.45 ✓ estrictamente decreciente
  Max mult:   2000 (20x)   RTP: 95.97%

MEDIUM RISK
  Almacenado: [7800, 1800, 800, 450, 250, 150, 90, 60, 38, 60, 90, 150, 250, 450, 800, 1800, 7800]
  Float (x):  [78, 18, 8, 4.5, 2.5, 1.5, 0.9, 0.60, 0.38, 0.60, 0.9, 1.5, 2.5, 4.5, 8, 18, 78]
  Orden:      78 > 18 > 8 > 4.5 > 2.5 > 1.5 > 0.9 > 0.60 > 0.38 ✓ estrictamente decreciente
  Max mult:   7800 (78x)   RTP: 96.02%

HIGH RISK
  Almacenado: [99000, 12900, 2600, 890, 400, 200, 20, 17, 12, 17, 20, 200, 400, 890, 2600, 12900, 99000]
  Float (x):  [990, 129, 26, 8.9, 4, 2, 0.20, 0.17, 0.12, 0.17, 0.20, 2, 4, 8.9, 26, 129, 990]
  Orden:      990 > 129 > 26 > 8.9 > 4 > 2 > 0.20 > 0.17 > 0.12 ✓ estrictamente decreciente
  Max mult:   99000 (990x)  RTP: 96.11%
```

---

### Resumen de RTP por configuración

| Config | RTP | House edge mult. | Net bankroll (con 3% fees) | Patrón |
|---|---|---|---|---|
| 8 – Low | 95.98% | 4.02% | **+1.02%** | ✓ monótono |
| 8 – Med | 95.90% | 4.10% | **+1.10%** | ✓ monótono |
| 8 – High | 96.09% | 3.91% | **+0.91%** | ✓ monótono |
| 10 – Low | 96.05% | 3.95% | **+0.95%** | ✓ monótono |
| 10 – Med | 96.03% | 3.97% | **+0.97%** | ✓ monótono |
| 10 – High | 95.97% | 4.03% | **+1.03%** | ✓ monótono |
| 12 – Low | 96.07% | 3.93% | **+0.93%** | ✓ monótono |
| 12 – Med | 95.91% | 4.09% | **+1.09%** | ✓ monótono |
| 12 – High | 95.96% | 4.04% | **+1.04%** | ✓ monótono |
| 14 – Low | 96.07% | 3.93% | **+0.93%** | ✓ monótono |
| 14 – Med | 96.04% | 3.96% | **+0.96%** | ✓ monótono |
| 14 – High | 96.11% | 3.89% | **+0.89%** | ✓ monótono |
| 16 – Low | 95.97% | 4.03% | **+1.03%** | ✓ monótono |
| 16 – Med | 96.02% | 3.98% | **+0.98%** | ✓ monótono |
| 16 – High | 96.11% | 3.89% | **+0.89%** | ✓ monótono |

**Todas las 15 configuraciones son autosustentables con un net de +0.89% a +1.10% por apuesta.**
**Todas las tablas cumplen el patrón estrictamente decreciente: borde (máximo) → centro (mínimo).**

---

## 4. Verificación Matemática del RTP

### Fórmula general

```
RTP = Σ(k=0 a rows) [ C(rows,k) × multiplier_float[k] ] / 2^rows

Donde:
  C(rows,k) = rows! / (k! × (rows-k)!)
  multiplier_float[k] = valor_almacenado / 100
```

### Verificación 8 rows — Low Risk (nueva tabla)

```
rows=8, 2^8=256
Probs×256: [1, 8, 28, 56, 70, 56, 28, 8, 1]
Mults:     [5.6, 2.1, 1.1, 1.0, 0.39, 1.0, 1.1, 2.1, 5.6]

Σ = 1×5.6 + 8×2.1 + 28×1.1 + 56×1.0 + 70×0.39
    + 56×1.0 + 28×1.1 + 8×2.1 + 1×5.6
  = 5.6 + 16.8 + 30.8 + 56.0 + 27.3 + 56.0 + 30.8 + 16.8 + 5.6
  = 245.7

RTP = 245.7 / 256 = 95.98% ✓
Net bankroll = 97.0% (recibido) − 95.98% (pagado) = +1.02% ✓
```

### Verificación 10 rows — High Risk (nueva tabla)

```
rows=10, 2^10=1024
Probs×1024: [1, 10, 45, 120, 210, 252, 210, 120, 45, 10, 1]
Mults:      [75, 9.9, 3, 0.9, 0.3, 0.09, 0.3, 0.9, 3, 9.9, 75]

Σ = 75 + 99 + 135 + 108 + 63 + 252×0.09 + 63 + 108 + 135 + 99 + 75
  = 75 + 99 + 135 + 108 + 63 + 22.68 + 63 + 108 + 135 + 99 + 75
  = 982.68

RTP = 982.68 / 1024 = 95.97% ✓
```

### Verificación 12 rows — Low Risk (tabla corregida)

```
rows=12, 2^12=4096
Probs×4096: [1, 12, 66, 220, 495, 792, 924, 792, 495, 220, 66, 12, 1]
Mults:     [7.5, 4.5, 2.8, 1.8, 1.1, 0.7, 0.49, 0.7, 1.1, 1.8, 2.8, 4.5, 7.5]

Mitad = 1×7.5 + 12×4.5 + 66×2.8 + 220×1.8 + 495×1.1 + 792×0.7
      = 7.5 + 54.0 + 184.8 + 396.0 + 544.5 + 554.4 = 1741.2

Σ = 2×1741.2 + 924×0.49 = 3482.4 + 452.76 = 3935.16

RTP = 3935.16 / 4096 = 96.07% ✓
Monotonía: 7.5 > 4.5 > 2.8 > 1.8 > 1.1 > 0.7 > 0.49 ✓
```

### Verificación 12 rows — High Risk (tabla con mayor ajuste)

```
rows=12, 2^12=4096
Probs×4096: [1, 12, 66, 220, 495, 792, 924, 792, 495, 220, 66, 12, 1]
Mults: [168, 24, 8, 2, 0.7, 0.15, 0.11, 0.15, 0.7, 2, 8, 24, 168]

Σ = 168 + 288 + 528 + 440 + 346.5 + 118.8 + 924×0.11
    + 118.8 + 346.5 + 440 + 528 + 288 + 168
  = 168 + 288 + 528 + 440 + 346.5 + 118.8 + 101.64
    + 118.8 + 346.5 + 440 + 528 + 288 + 168
  = 3930.24

RTP = 3930.24 / 4096 = 95.96% ✓
```

### Verificación 16 rows — High Risk (tabla corregida)

```
rows=16, 2^16=65536
Probs×65536: [1,16,120,560,1820,4368,8008,11440,12870,11440,8008,4368,1820,560,120,16,1]
Mults: [990, 129, 26, 8.9, 4, 2, 0.20, 0.17, 0.12, ...]

Mitad = 1×990 + 16×129 + 120×26 + 560×8.9 + 1820×4 + 4368×2 + 8008×0.20 + 11440×0.17
      = 990 + 2064 + 3120 + 4984 + 7280 + 8736 + 1601.6 + 1944.8
      = 30720.4

Σ = 2×30720.4 + 12870×0.12 = 61440.8 + 1544.4 = 62985.2

RTP = 62985.2 / 65536 = 96.11% ✓
Monotonía: 990 > 129 > 26 > 8.9 > 4 > 2 > 0.20 > 0.17 > 0.12 ✓
```

---

## 5. Análisis de Liquidez con 100 EVA

### 5.1 Apuesta máxima por configuración

> `maxTotalWager = bankroll / maxMultiplier_float = 100 / (maxMult / 100) = 10000 / maxMult_almacenado`
> `minBet = 0.1 EVA` → para ser viable: `maxTotalWager ≥ 0.1 EVA`

| Config | Max Mult. almac. | Max Mult. float | Max Wager (100 EVA) | ¿Viable con minBet=0.1? | Quien limita |
|---|---|---|---|---|---|
| **8 – Low** | 560 | 5.60x | **17.86 EVA** | ✅ | maxBet (5 EVA) |
| **8 – Med** | 1300 | 13.00x | **7.69 EVA** | ✅ | maxBet (5 EVA) |
| **8 – High** | 1800 | 18.00x | **5.56 EVA** | ✅ | maxBet (5 EVA) |
| **10 – Low** | 890 | 8.90x | **11.24 EVA** | ✅ | maxBet (5 EVA) |
| **10 – Med** | 2200 | 22.00x | **4.55 EVA** | ✅ | liquidez |
| **10 – High** | 7500 | 75.00x | **1.33 EVA** | ✅ | liquidez |
| **12 – Low** | 750 | 7.50x | **13.33 EVA** | ✅ | maxBet (5 EVA) |
| **12 – Med** | 3000 | 30.00x | **3.33 EVA** | ✅ | liquidez |
| **12 – High** | 16800 | 168.00x | **0.595 EVA** | ✅ | liquidez |
| **14 – Low** | 910 | 9.10x | **10.99 EVA** | ✅ | maxBet (5 EVA) |
| **14 – Med** | 5200 | 52.00x | **1.92 EVA** | ✅ | liquidez |
| **14 – High** | 52400 | 524.00x | **0.191 EVA** | ✅ | liquidez |
| **16 – Low** | 2000 | 20.00x | **5.00 EVA** | ✅ | liquidez/maxBet |
| **16 – Med** | 7800 | 78.00x | **1.28 EVA** | ✅ | liquidez |
| **16 – High** | 99000 | 990.00x | **0.101 EVA** | ✅ `(0.101 > 0.1)` | liquidez |

**Con 100 EVA y minBet = 0.1 EVA, las 15 configuraciones son viables.** La más justa es 16-High con un máximo de 0.101 EVA — funcional pero apuesta pequeña, lo cual es correcto para un multiplicador extremo.

### 5.2 Verificación de viabilidad para 16-High (el caso más ajustado)

```
Bankroll: 100 EVA
Max multiplier almacenado: 99000
Max wager = 100 × 100 / 99000 = 0.10101 EVA

Con numDrops=1, betAmount=0.101 EVA:
  maxPayout = 0.101 × 99000 × 1 / 100 = 99.99 EVA ≤ 100 EVA ✅

Con numDrops=10, betAmount=0.0101 EVA:
  totalWager = 0.101 EVA ≥ minBet (0.1) ✅
  maxPayout  = 0.0101 × 99000 × 10 / 100 = 99.99 EVA ≤ 100 EVA ✅
```

---

## 6. Configuración Completa para Mainnet

### 6.1 Contrato Plinko

```solidity
// ─── 1. Filas habilitadas ────────────────────────────────────────────────────
plinko.setAllowedRows([8, 10, 12, 14, 16]);

// ─── 2. Límites de apuesta ───────────────────────────────────────────────────
//  minBet = 0.1 EVA → funciona para todas las configs con 100 EVA bankroll
//  maxBet = 5 EVA   → limita las configs de bajo multiplicador (8-12 low/med)
//                     las configs de alto multiplicador quedan limitadas
//                     por la liquidez automáticamente
plinko.setBetLimits(0.1 ether, 5 ether);

// ─── 3. Máx. drops por apuesta ───────────────────────────────────────────────
plinko.setMaxDropsPerBet(10);

// ─── 4. Control de apuestas pendientes ──────────────────────────────────────
plinko.setMaxPendingBetsPerPlayer(5);
plinko.setMaxTotalPendingBets(30);

// ─── 5. Expiración de apuestas (~15 min en Arbitrum, 250 ms/bloque) ─────────
plinko.setBetExpiryBlocks(3600);
```

### 6.2 Tablas de multiplicadores (15 llamadas a setMultipliers)

```solidity
// ─── 8 Rows ──────────────────────────────────────────────────────────────────
uint256[] memory r8low  = [560, 210, 110, 100, 39, 100, 110, 210, 560];
uint256[] memory r8med  = [1300, 300, 130, 70, 29, 70, 130, 300, 1300];
uint256[] memory r8high = [1800, 560, 120, 40, 12, 40, 120, 560, 1800];
plinko.setMultipliers(8, Plinko.RiskLevel.Low,    r8low);
plinko.setMultipliers(8, Plinko.RiskLevel.Medium, r8med);
plinko.setMultipliers(8, Plinko.RiskLevel.High,   r8high);

// ─── 10 Rows ─────────────────────────────────────────────────────────────────
uint256[] memory r10low  = [890, 300, 140, 110, 100, 38, 100, 110, 140, 300, 890];
uint256[] memory r10med  = [2200, 500, 200, 140, 60, 28, 60, 140, 200, 500, 2200];
uint256[] memory r10high = [7500, 990, 300, 90, 30, 9, 30, 90, 300, 990, 7500];
plinko.setMultipliers(10, Plinko.RiskLevel.Low,    r10low);
plinko.setMultipliers(10, Plinko.RiskLevel.Medium, r10med);
plinko.setMultipliers(10, Plinko.RiskLevel.High,   r10high);

// ─── 12 Rows ─────────────────────────────────────────────────────────────────
uint256[] memory r12low  = [750, 450, 280, 180, 110, 70, 49, 70, 110, 180, 280, 450, 750];
uint256[] memory r12med  = [3000, 700, 300, 160, 90, 70, 65, 70, 90, 160, 300, 700, 3000];
uint256[] memory r12high = [16800, 2400, 800, 200, 70, 15, 11, 15, 70, 200, 800, 2400, 16800];
plinko.setMultipliers(12, Plinko.RiskLevel.Low,    r12low);
plinko.setMultipliers(12, Plinko.RiskLevel.Medium, r12med);
plinko.setMultipliers(12, Plinko.RiskLevel.High,   r12high);

// ─── 14 Rows ─────────────────────────────────────────────────────────────────
uint256[] memory r14low  = [910, 520, 240, 180, 130, 110, 85, 50, 85, 110, 130, 180, 240, 520, 910];
uint256[] memory r14med  = [5200, 1300, 430, 300, 150, 85, 65, 58, 65, 85, 150, 300, 430, 1300, 5200];
uint256[] memory r14high = [52400, 7000, 1500, 370, 160, 50, 30, 9, 30, 50, 160, 370, 1500, 7000, 52400];
plinko.setMultipliers(14, Plinko.RiskLevel.Low,    r14low);
plinko.setMultipliers(14, Plinko.RiskLevel.Medium, r14med);
plinko.setMultipliers(14, Plinko.RiskLevel.High,   r14high);

// ─── 16 Rows ─────────────────────────────────────────────────────────────────
uint256[] memory r16low  = [2000, 1100, 600, 350, 200, 130, 90, 80, 45, 80, 90, 130, 200, 350, 600, 1100, 2000];
uint256[] memory r16med  = [7800, 1800, 800, 450, 250, 150, 90, 60, 38, 60, 90, 150, 250, 450, 800, 1800, 7800];
uint256[] memory r16high = [99000, 12900, 2600, 890, 400, 200, 20, 17, 12, 17, 20, 200, 400, 890, 2600, 12900, 99000];
plinko.setMultipliers(16, Plinko.RiskLevel.Low,    r16low);
plinko.setMultipliers(16, Plinko.RiskLevel.Medium, r16med);
plinko.setMultipliers(16, Plinko.RiskLevel.High,   r16high);
```

### 6.3 PaymentHandler — Registro del juego

```solidity
paymentHandler.registerGame(
    address(plinko),    // game: dirección del contrato Plinko
    address(plinko),    // payoutTarget: DEBE ser el propio Plinko (bankroll)
    feeRecipient,       // wallet del operador que recibe el 1.5%
    150,                // houseEdgeBps: 1.5% → va al feeRecipient en cada apuesta
    150                 // referralBps:  1.5% → va al contrato de referidos
);
```

> **Crítico:** `payoutTarget` DEBE ser `address(plinko)`. Si se pone otra dirección, el netAmount (97%) no vuelve al bankroll y el contrato queda insolvente de inmediato.

### 6.4 Fondear el bankroll

```solidity
// Transferir 100 EVA al contrato Plinko
evaToken.transfer(address(plinko), 100 ether);

// Verificar
assert(plinko.availableLiquidity() == 100 ether);
```

---

## 7. Secuencia de Deploy

```
 1. Verificar que PaymentHandler y RandomProviderV2 están desplegados ✓
    PaymentHandler:  0xabe66fc056dd0e116b90201e487ea102fd7df1ba
    RandomProviderV2: 0x6513baa6c53a570ec899bb1504a95f160b8d7850
    EVA Token:       0x45D9831d8751B2325f3DBf48db748723726e1C8c
 2. Verificar que MultiLevelReferral está desplegado y registrado ✓
 3. Deploy Plinko.sol:
      Plinko(paymentHandler, randomProviderV2, evaToken, 0, 0)
      (minBet y maxBet se setean en paso 6)
 4. Registrar Plinko en PaymentHandler (sección 6.3)
 5. Registrar Plinko en RandomProviderV2 como consumer:
      randomProviderV2.setConsumerStatus(address(plinko), true, 1)
 6. setMultipliers × 15 (sección 6.2)
 7. setAllowedRows([8, 10, 12, 14, 16])
 8. setBetLimits(0.1 ether, 5 ether)
 9. setMaxDropsPerBet(10)
10. setMaxPendingBetsPerPlayer(5)
11. setMaxTotalPendingBets(30)
12. setBetExpiryBlocks(3600)
13. evaToken.transfer(address(plinko), 100 ether)
14. Verificar: plinko.availableLiquidity() == 100 EVA
15. setPaused(false)

SCRIPT: npx hardhat run scripts/mainnet/deploy-plinko-v5.ts --network arbitrum
  (ejecuta los pasos 3-14 de forma automática)
```

### Verificaciones post-deploy

```solidity
// Configuración del contrato
assert(plinko.minBet() == 0.1 ether);
assert(plinko.maxBet() == 5 ether);
assert(plinko.maxDropsPerBet() == 10);
assert(plinko.paused() == false);
assert(plinko.availableLiquidity() == 100 ether);
assert(plinko.allowedRows(8) == true);
assert(plinko.allowedRows(16) == true);

// Verificar multiplicadores ejemplo
uint256[] memory mults = plinko.getMultipliers(8, RiskLevel.Low);
assert(mults[4] == 39);  // centro ajustado

// Verificar PaymentHandler
(bool enabled, address target, , uint16 hEdge, uint16 ref) =
    paymentHandler.getGameConfig(address(plinko));
assert(enabled == true);
assert(target == address(plinko));
assert(hEdge == 150);
assert(ref == 150);
```

---

## Apéndice: Resumen de parámetros finales

| Parámetro | Valor |
|---|---|
| Bankroll inicial | **100 EVA** |
| houseEdgeBps (PaymentHandler) | **150** (1.5% → feeRecipient) |
| referralBps (PaymentHandler) | **150** (1.5% → referral contract) |
| RTP de multiplicadores | **~96%** |
| Net al bankroll por wager | **~+1%** (autosustentable ✅) |
| minBet | **0.1 EVA** |
| maxBet | **5 EVA** |
| maxDropsPerBet | **10** |
| maxPendingBetsPerPlayer | **5** |
| maxTotalPendingBets | **30** |
| betExpiryBlocks | **3600** (~15 min Arbitrum) |
| Filas habilitadas | **8, 10, 12, 14, 16** (todas) |
| Multiplicadores más extremos | **990x** (16-High, slot 0) |
| Max apuesta posible en 16-High | **~0.101 EVA** por transacción |

*Documento actualizado el 23 de abril de 2026.*
