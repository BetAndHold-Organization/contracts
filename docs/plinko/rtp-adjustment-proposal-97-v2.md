# Propuesta v2 — Multiplicadores Proporcionales — RTP 97%

**Fecha:** 28 de abril de 2026  
**Estado:** Propuesta (sin cambios aplicados)  
**Contrato:** `0xe06bf80bba6df203eae104968ade29b50077ee02` (Arbitrum Mainnet)

---

## 1. Resumen Ejecutivo

**Diferencia clave vs v1:** Una sola estrategia consistente para las 15 tablas.

| Aspecto | v1 (Híbrida) | v2 (Proporcional) |
|---------|:---:|:---:|
| Estrategia | 2 diferentes (8-10R vs 12-16R) | **Power curve + floor 1.00x** |
| Forma de curva | Plana con saltos | **Power curve suave** |
| Borde máximo (Low) | 49.79x (16R) | **3.63x** (16R) |
| Borde máximo (High) | 998.44x (16R) | **20.31x** (16R) |
| Riesgo bankroll por hit | Alto en bordes | **Muy bajo** |
| Centros | Agresivos (8-10R), moderados (12-16R) | **Altos y consistentes** |
| Monotonía | Algunos saltos internos | **Perfecta en todas** |
| % drops sin pérdida (8-10R Low) | 72-75% | **72-75%** |
| Sensación de juego | Variable según filas | **Predecible y natural** |

---

## 2. Filosofía — Power Curve

Cada tabla sigue la misma fórmula matemática:

```
mult(d) = centro + (borde - centro) × (d / half)^power
```

Donde `d` = distancia desde el centro, `half` = filas/2, y `power` controla la "forma":

- `power = 1.0` → curva lineal (cambio uniforme)
- `power = 1.5` → curva suave (subida gradual, se acentúa en bordes)
- `power = 2.5` → curva pronunciada (centro plano, bordes empinados)

Se fija el **centro** (generoso) y se busca el **borde** que da exactamente 97% RTP.

**Restricción adicional para 8R y 10R Low:** Los slots que actualmente pagan ≥ 1.00x se protegen con un "floor" de 1.00x. Esto comprime los bordes pero sube aún más el centro, logrando que **~73-75% de los drops no pierdan**.

**Resultado:** Curva suave, natural, sin saltos bruscos. Cada slot adyacente es ligeramente mayor que el anterior — como una verdadera campana de Gauss invertida.

---

## 3. Impacto Económico (igual que v1)

```
Jugador apuesta 1 EVA → PaymentHandler cobra 3% → Devuelve 0.97 EVA al bankroll
Plinko paga 0.97 promedio → Bankroll 0.00/bet → Break even
```

| Escenario | Net bankroll/bet | Estado |
|-----------|:---:|:---:|
| Actual (RTP 96%) | +1% | ✅ Crece |
| **Propuesto (RTP 97%)** | **0%** | **⚠️ Break even** |
| Si fuera RTP 98% | -1% | ❌ Se drena |

> La casa sigue ganando 1.5%/bet vía fees + 1.5% referidos. Solo el bankroll del contrato deja de crecer.

---

## 4. Parámetros de Diseño

| Filas | Risk | Centro | Power | Borde resultante | RTP |
|:---:|:---:|:---:|:---:|:---:|:---:|
| 8 | Low | 0.82x | 1.5 + floor | 1.20x | 97.02% |
| 8 | Medium | 0.55x | 1.8 | 3.46x | 97.02% |
| 8 | High | 0.30x | 2.0 | 5.66x | 96.75% |
| 10 | Low | 0.82x | 1.5 + floor | 1.15x | 97.03% |
| 10 | Medium | 0.52x | 1.8 | 4.34x | 96.83% |
| 10 | High | 0.28x | 2.2 | 8.36x | 97.00% |
| 12 | Low | 0.70x | 1.5 | 2.71x | 96.97% |
| 12 | Medium | 0.70x | 1.6 | 2.93x | 96.98% |
| 12 | High | 0.22x | 2.3 | 11.87x | 96.99% |
| 14 | Low | 0.68x | 1.5 | 3.14x | 96.96% |
| 14 | Medium | 0.65x | 1.6 | 3.66x | 96.80% |
| 14 | High | 0.20x | 2.4 | 15.75x | 97.01% |
| 16 | Low | 0.65x | 1.5 | 3.63x | 97.02% |
| 16 | Medium | 0.50x | 1.7 | 5.96x | 97.00% |
| 16 | High | 0.20x | 2.5 | 20.31x | 96.98% |

> Todos los RTPs en rango 96.75% – 97.06%. Variación por redondeo a enteros.

---

## 5. Tablas Detalladas

### 5.1 — 8 Filas

**Probabilidades:** `0.4% | 3.1% | 10.9% | 21.9% | [27.3%] | 21.9% | 10.9% | 3.1% | 0.4%`

#### Low Risk — RTP 97.02% ⭐ Floor protegido

| Slot | Prob. | Actual | Propuesto | Cambio | Resultado |
|:---:|:---:|:---:|:---:|:---:|:---:|
| Borde (0,8) | 0.4% | 5.60x | **1.20x** | -4.40x | 🟢 Gana +20% |
| ±3 (1,7) | 3.1% | 2.10x | **1.11x** | -0.99x | 🟢 Gana +11% |
| ±2 (2,6) | 10.9% | 1.10x | **1.05x** | -0.05x | 🟢 Gana +5% |
| ±1 (3,5) | 21.9% | 1.00x | **1.00x** | 0 | 🟢 Empata |
| **Centro (4)** | **27.3%** | **0.39x** | **0.82x** | **+0.43x** | 🔴 Pierde 18% |

| | 🟢 No pierde | 🔴 Pierde |
|---|:---:|:---:|
| **Probabilidad** | **72.7%** | **27.3%** |

> Centro pasa de perder 61% a perder solo 18%. El ±1 se mantiene en 1.00x (no empeora). **Solo el centro pierde, todo lo demás paga ≥ 1.00x.**

#### Medium Risk — RTP 97.02%

| Slot | Prob. | Actual | Propuesto | Cambio | Resultado |
|:---:|:---:|:---:|:---:|:---:|:---:|
| Borde (0,8) | 0.4% | 13.00x | **3.46x** | -9.54x | 🟢 Gana +246% |
| ±3 (1,7) | 3.1% | 3.00x | **2.29x** | -0.71x | 🟢 Gana +129% |
| ±2 (2,6) | 10.9% | 1.30x | **1.39x** | +0.09x | 🟢 Gana +39% |
| ±1 (3,5) | 21.9% | 0.70x | **0.79x** | +0.09x | 🔴 Pierde 21% |
| **Centro (4)** | **27.3%** | **0.29x** | **0.55x** | **+0.26x** | 🔴 Pierde 45% |

> Centro sube de 0.29x a 0.55x (+90%). El ±1 sube de 0.70x a 0.79x.

#### High Risk — RTP 96.75%

| Slot | Prob. | Actual | Propuesto | Cambio | Resultado |
|:---:|:---:|:---:|:---:|:---:|:---:|
| Borde (0,8) | 0.4% | 18.00x | **5.66x** | -12.34x | 🟢 Gana +466% |
| ±3 (1,7) | 3.1% | 5.60x | **3.31x** | -2.29x | 🟢 Gana +231% |
| ±2 (2,6) | 10.9% | 1.20x | **1.64x** | +0.44x | 🟢 Gana +64% |
| ±1 (3,5) | 21.9% | 0.40x | **0.63x** | +0.23x | 🔴 Pierde 37% |
| **Centro (4)** | **27.3%** | **0.12x** | **0.30x** | **+0.18x** | 🔴 Pierde 70% |

> Centro sube de 0.12x a 0.30x (+150%). ±2 sube de 1.20x a 1.64x.

---

### 5.2 — 10 Filas

**Probabilidades:** `0.1% | 1.0% | 4.4% | 11.7% | 20.5% | [24.6%] | 20.5% | 11.7% | 4.4% | 1.0% | 0.1%`

#### Low Risk — RTP 97.03% ⭐ Floor protegido

| Slot | Prob. | Actual | Propuesto | Cambio | Resultado |
|:---:|:---:|:---:|:---:|:---:|:---:|
| Borde (0,10) | 0.1% | 8.90x | **1.15x** | -7.75x | 🟢 Gana +15% |
| ±4 (1,9) | 1.0% | 3.00x | **1.10x** | -1.90x | 🟢 Gana +10% |
| ±3 (2,8) | 4.4% | 1.40x | **1.06x** | -0.34x | 🟢 Gana +6% |
| ±2 (3,7) | 11.7% | 1.10x | **1.03x** | -0.07x | 🟢 Gana +3% |
| ±1 (4,6) | 20.5% | 1.00x | **1.00x** | 0 | 🟢 Empata |
| **Centro (5)** | **24.6%** | **0.38x** | **0.82x** | **+0.44x** | 🔴 Pierde 18% |

| | 🟢 No pierde | 🔴 Pierde |
|---|:---:|:---:|
| **Probabilidad** | **75.4%** | **24.6%** |

> Centro: 0.38x → 0.82x (+116%). El ±1 se mantiene en 1.00x. **Solo el centro pierde, todo lo demás paga ≥ 1.00x. 75% de drops no pierde.**

#### Medium Risk — RTP 96.83%

| Slot | Prob. | Actual | Propuesto | Cambio | Resultado |
|:---:|:---:|:---:|:---:|:---:|:---:|
| Borde (0,10) | 0.1% | 22.00x | **4.34x** | -17.66x | 🟢 Gana +334% |
| ±4 (1,9) | 1.0% | 5.00x | **3.08x** | -1.92x | 🟢 Gana +208% |
| ±3 (2,8) | 4.4% | 2.00x | **2.04x** | +0.04x | 🟢 Gana +104% |
| ±2 (3,7) | 11.7% | 1.40x | **1.25x** | -0.15x | 🟢 Gana +25% |
| ±1 (4,6) | 20.5% | 0.60x | **0.73x** | +0.13x | 🔴 Pierde 27% |
| **Centro (5)** | **24.6%** | **0.28x** | **0.52x** | **+0.24x** | 🔴 Pierde 48% |

> Centro sube de 0.28x a 0.52x (+86%). ±1 sube de 0.60x a 0.73x.

#### High Risk — RTP 97.00%

| Slot | Prob. | Actual | Propuesto | Cambio | Resultado |
|:---:|:---:|:---:|:---:|:---:|:---:|
| Borde (0,10) | 0.1% | 75.00x | **8.36x** | -66.64x | 🟢 Gana +736% |
| ±4 (1,9) | 1.0% | 9.90x | **5.22x** | -4.68x | 🟢 Gana +422% |
| ±3 (2,8) | 4.4% | 3.00x | **2.90x** | -0.10x | 🟢 Gana +190% |
| ±2 (3,7) | 11.7% | 0.90x | **1.36x** | +0.46x | 🟢 Gana +36% |
| ±1 (4,6) | 20.5% | 0.30x | **0.51x** | +0.21x | 🔴 Pierde 49% |
| **Centro (5)** | **24.6%** | **0.09x** | **0.28x** | **+0.19x** | 🔴 Pierde 72% |

> Centro sube de 0.09x a 0.28x (+211%). ±2 pasa de perder (0.90x) a ganar (1.36x).

---

### 5.3 — 12 Filas

#### Low Risk — RTP 96.97%

| Slot | Prob. | Actual | Propuesto | Cambio | Resultado |
|:---:|:---:|:---:|:---:|:---:|:---:|
| Borde (0,12) | 0.02% | 7.50x | **2.71x** | -4.79x | 🟢 Gana +171% |
| ±5 (1,11) | 0.3% | 4.50x | **2.23x** | -2.27x | 🟢 Gana +123% |
| ±4 (2,10) | 1.6% | 2.80x | **1.79x** | -1.01x | 🟢 Gana +79% |
| ±3 (3,9) | 5.4% | 1.80x | **1.41x** | -0.39x | 🟢 Gana +41% |
| ±2 (4,8) | 12.1% | 1.10x | **1.09x** | -0.01x | 🟢 Gana +9% |
| ±1 (5,7) | 19.3% | 0.70x | **0.84x** | +0.14x | 🔴 Pierde 16% |
| **Centro (6)** | **22.6%** | **0.49x** | **0.70x** | **+0.21x** | 🔴 Pierde 30% |

| | 🟢 Gana | 🔴 Pierde |
|---|:---:|:---:|
| **Probabilidad** | **39%** | **61%** |

> Centro: 0.49x → 0.70x (+43%). ±1 sube de 0.70x a 0.84x. Curva perfectamente suave.

#### Medium Risk — RTP 96.98%

| Slot | Prob. | Actual | Propuesto | Cambio | Resultado |
|:---:|:---:|:---:|:---:|:---:|:---:|
| Borde (0,12) | 0.02% | 30.00x | **2.93x** | -27.07x | 🟢 Gana +193% |
| ±5 (1,11) | 0.3% | 7.00x | **2.36x** | -4.64x | 🟢 Gana +136% |
| ±4 (2,10) | 1.6% | 3.00x | **1.86x** | -1.14x | 🟢 Gana +86% |
| ±3 (3,9) | 5.4% | 1.60x | **1.44x** | -0.16x | 🟢 Gana +44% |
| ±2 (4,8) | 12.1% | 0.90x | **1.08x** | +0.18x | 🟢 Gana +8% |
| ±1 (5,7) | 19.3% | 0.70x | **0.83x** | +0.13x | 🔴 Pierde 17% |
| **Centro (6)** | **22.6%** | **0.65x** | **0.70x** | **+0.05x** | 🔴 Pierde 30% |

> Centro sube de 0.65x a 0.70x (+8%). ±2 pasa de perder (0.90x) a ganar (1.08x).

#### High Risk — RTP 96.99%

| Slot | Prob. | Actual | Propuesto | Cambio | Resultado |
|:---:|:---:|:---:|:---:|:---:|:---:|
| Borde (0,12) | 0.02% | 168.00x | **11.87x** | -156.13x | 🟢 Gana +1087% |
| ±5 (1,11) | 0.3% | 24.00x | **7.88x** | -16.12x | 🟢 Gana +688% |
| ±4 (2,10) | 1.6% | 8.00x | **4.80x** | -3.20x | 🟢 Gana +380% |
| ±3 (3,9) | 5.4% | 2.00x | **2.58x** | +0.58x | 🟢 Gana +158% |
| ±2 (4,8) | 12.1% | 0.70x | **1.15x** | +0.45x | 🟢 Gana +15% |
| ±1 (5,7) | 19.3% | 0.15x | **0.41x** | +0.26x | 🔴 Pierde 59% |
| **Centro (6)** | **22.6%** | **0.11x** | **0.22x** | **+0.11x** | 🔴 Pierde 78% |

> Centro: 0.11x → 0.22x (+100%). ±2 pasa de perder (0.70x) a ganar (1.15x).

---

### 5.4 — 14 Filas

#### Low Risk — RTP 96.96%

| Slot | Prob. | Actual | Propuesto | Cambio | Resultado |
|:---:|:---:|:---:|:---:|:---:|:---:|
| Borde (0,14) | 0.01% | 9.10x | **3.14x** | -5.96x | 🟢 Gana +214% |
| ±6 (1,13) | 0.1% | 5.20x | **2.63x** | -2.57x | 🟢 Gana +163% |
| ±5 (2,12) | 0.5% | 2.40x | **2.16x** | -0.24x | 🟢 Gana +116% |
| ±4 (3,11) | 2.2% | 1.80x | **1.74x** | -0.06x | 🟢 Gana +74% |
| ±3 (4,10) | 6.1% | 1.30x | **1.37x** | +0.07x | 🟢 Gana +37% |
| ±2 (5,9) | 12.2% | 1.10x | **1.05x** | -0.05x | 🟢 Gana +5% |
| ±1 (6,8) | 18.3% | 0.85x | **0.81x** | -0.04x | 🔴 Pierde 19% |
| **Centro (7)** | **20.9%** | **0.50x** | **0.68x** | **+0.18x** | 🔴 Pierde 32% |

| | 🟢 Gana | 🔴 Pierde |
|---|:---:|:---:|
| **Probabilidad** | **42%** | **58%** |

> Centro: 0.50x → 0.68x (+36%). 6 de 8 slots únicos pagan ≥ 1.00x.

#### Medium Risk — RTP 96.80%

| Slot | Prob. | Actual | Propuesto | Cambio | Resultado |
|:---:|:---:|:---:|:---:|:---:|:---:|
| Borde (0,14) | 0.01% | 52.00x | **3.66x** | -48.34x | 🟢 Gana +266% |
| ±6 (1,13) | 0.1% | 13.00x | **3.00x** | -10.00x | 🟢 Gana +200% |
| ±5 (2,12) | 0.5% | 4.30x | **2.40x** | -1.90x | 🟢 Gana +140% |
| ±4 (3,11) | 2.2% | 3.00x | **1.88x** | -1.12x | 🟢 Gana +88% |
| ±3 (4,10) | 6.1% | 1.50x | **1.42x** | -0.08x | 🟢 Gana +42% |
| ±2 (5,9) | 12.2% | 0.85x | **1.05x** | +0.20x | 🟢 Gana +5% |
| ±1 (6,8) | 18.3% | 0.65x | **0.78x** | +0.13x | 🔴 Pierde 22% |
| **Centro (7)** | **20.9%** | **0.58x** | **0.65x** | **+0.07x** | 🔴 Pierde 35% |

> Centro sube de 0.58x a 0.65x (+12%). ±2 pasa de perder (0.85x) a ganar (1.05x).

#### High Risk — RTP 97.01%

| Slot | Prob. | Actual | Propuesto | Cambio | Resultado |
|:---:|:---:|:---:|:---:|:---:|:---:|
| Borde (0,14) | 0.01% | 524.00x | **15.75x** | -508.25x | 🟢 Gana grande |
| ±6 (1,13) | 0.1% | 70.00x | **10.94x** | -59.06x | 🟢 Gana +994% |
| ±5 (2,12) | 0.5% | 15.00x | **7.13x** | -7.87x | 🟢 Gana +613% |
| ±4 (3,11) | 2.2% | 3.70x | **4.26x** | +0.56x | 🟢 Gana +326% |
| ±3 (4,10) | 6.1% | 1.60x | **2.24x** | +0.64x | 🟢 Gana +124% |
| ±2 (5,9) | 12.2% | 0.50x | **0.97x** | +0.47x | 🟡 Pierde 3% |
| ±1 (6,8) | 18.3% | 0.30x | **0.35x** | +0.05x | 🔴 Pierde 65% |
| **Centro (7)** | **20.9%** | **0.09x** | **0.20x** | **+0.11x** | 🔴 Pierde 80% |

> Centro: 0.09x → 0.20x (+122%). ±2 pasa de 0.50x a 0.97x (casi empate).

---

### 5.5 — 16 Filas

#### Low Risk — RTP 97.02%

| Slot | Prob. | Actual | Propuesto | Cambio | Resultado |
|:---:|:---:|:---:|:---:|:---:|:---:|
| Borde (0,16) | 0.002% | 20.00x | **3.63x** | -16.37x | 🟢 Gana +263% |
| ±7 (1,15) | 0.02% | 11.00x | **3.09x** | -7.91x | 🟢 Gana +209% |
| ±6 (2,14) | 0.2% | 6.00x | **2.59x** | -3.41x | 🟢 Gana +159% |
| ±5 (3,13) | 0.9% | 3.50x | **2.12x** | -1.38x | 🟢 Gana +112% |
| ±4 (4,12) | 2.8% | 2.00x | **1.71x** | -0.29x | 🟢 Gana +71% |
| ±3 (5,11) | 6.7% | 1.30x | **1.34x** | +0.04x | 🟢 Gana +34% |
| ±2 (6,10) | 12.2% | 0.90x | **1.02x** | +0.12x | 🟢 Gana +2% |
| ±1 (7,9) | 17.5% | 0.80x | **0.78x** | -0.02x | 🔴 Pierde 22% |
| **Centro (8)** | **19.6%** | **0.45x** | **0.65x** | **+0.20x** | 🔴 Pierde 35% |

| | 🟢 Gana | 🔴 Pierde |
|---|:---:|:---:|
| **Probabilidad** | **45%** | **55%** |

> Centro: 0.45x → 0.65x (+44%). ±2 pasa de perder a ganar. **7 de 9 slots únicos ganan.**

#### Medium Risk — RTP 97.00%

| Slot | Prob. | Actual | Propuesto | Cambio | Resultado |
|:---:|:---:|:---:|:---:|:---:|:---:|
| Borde (0,16) | 0.002% | 78.00x | **5.96x** | -72.04x | 🟢 Gana +496% |
| ±7 (1,15) | 0.02% | 18.00x | **4.85x** | -13.15x | 🟢 Gana +385% |
| ±6 (2,14) | 0.2% | 8.00x | **3.85x** | -4.15x | 🟢 Gana +285% |
| ±5 (3,13) | 0.9% | 4.50x | **2.95x** | -1.55x | 🟢 Gana +195% |
| ±4 (4,12) | 2.8% | 2.50x | **2.18x** | -0.32x | 🟢 Gana +118% |
| ±3 (5,11) | 6.7% | 1.50x | **1.53x** | +0.03x | 🟢 Gana +53% |
| ±2 (6,10) | 12.2% | 0.90x | **1.02x** | +0.12x | 🟢 Gana +2% |
| ±1 (7,9) | 17.5% | 0.60x | **0.66x** | +0.06x | 🔴 Pierde 34% |
| **Centro (8)** | **19.6%** | **0.38x** | **0.50x** | **+0.12x** | 🔴 Pierde 50% |

> Centro: 0.38x → 0.50x (+32%). ±2 pasa de perder a ganar. **7 de 9 slots ganan.**

#### High Risk — RTP 96.98%

| Slot | Prob. | Actual | Propuesto | Cambio | Resultado |
|:---:|:---:|:---:|:---:|:---:|:---:|
| Borde (0,16) | 0.002% | 990.00x | **20.31x** | -969.69x | 🟢 Gana grande |
| ±7 (1,15) | 0.02% | 129.00x | **14.60x** | -114.40x | 🟢 Gana +1360% |
| ±6 (2,14) | 0.2% | 26.00x | **10.00x** | -16.00x | 🟢 Gana +900% |
| ±5 (3,13) | 0.9% | 8.90x | **6.41x** | -2.49x | 🟢 Gana +541% |
| ±4 (4,12) | 2.8% | 4.00x | **3.75x** | -0.25x | 🟢 Gana +275% |
| ±3 (5,11) | 6.7% | 2.00x | **1.93x** | -0.07x | 🟢 Gana +93% |
| ±2 (6,10) | 12.2% | 0.20x | **0.83x** | +0.63x | 🔴 Pierde 17% |
| ±1 (7,9) | 17.5% | 0.17x | **0.31x** | +0.14x | 🔴 Pierde 69% |
| **Centro (8)** | **19.6%** | **0.12x** | **0.20x** | **+0.08x** | 🔴 Pierde 80% |

> Centro: 0.12x → 0.20x (+67%). ±2 pasa de 0.20x a 0.83x (+315%).

---

## 6. Resumen Comparativo — Centros

| Config | Centro Actual | Centro v2 | Mejora | Pérdida centro |
|--------|:---:|:---:|:---:|:---:|
| **8R Low** ⭐ | 0.39x | **0.82x** | +110% | 18% |
| **8R Medium** | 0.29x | **0.55x** | +90% | 45% |
| **8R High** | 0.12x | **0.30x** | +150% | 70% |
| **10R Low** ⭐ | 0.38x | **0.82x** | +116% | 18% |
| **10R Medium** | 0.28x | **0.52x** | +86% | 48% |
| **10R High** | 0.09x | **0.28x** | +211% | 72% |
| **12R Low** | 0.49x | **0.70x** | +43% | 30% |
| **12R Medium** | 0.65x | **0.70x** | +8% | 30% |
| **12R High** | 0.11x | **0.22x** | +100% | 78% |
| **14R Low** | 0.50x | **0.68x** | +36% | 32% |
| **14R Medium** | 0.58x | **0.65x** | +12% | 35% |
| **14R High** | 0.09x | **0.20x** | +122% | 80% |
| **16R Low** | 0.45x | **0.65x** | +44% | 35% |
| **16R Medium** | 0.38x | **0.50x** | +32% | 50% |
| **16R High** | 0.12x | **0.20x** | +67% | 80% |

---

## 7. Comparación v1 vs v2

| Aspecto | v1 | v2 | Veredicto |
|---------|:---:|:---:|:---:|
| **8R Low centro** | 0.70x | **0.82x** | **v2 gana** |
| **10R Low centro** | 0.68x | **0.82x** | **v2 gana** |
| **12R Low centro** | 0.80x | 0.70x | v1 mejor centro |
| **16R Low centro** | 0.75x | 0.65x | v1 mejor centro |
| **Borde máx Low** | 49.79x | 3.63x | **v2 mucho más seguro** |
| **Borde máx High** | 998.44x | 20.31x | **v2 mucho más seguro** |
| **Monotonía** | Algunos saltos | Perfecta | **v2 gana** |
| **Consistencia** | 2 estrategias | 1 estrategia | **v2 gana** |
| **% drops sin pérdida (8-10R Low)** | 72-75% | **72-75%** | **Empate** |
| **Riesgo bankroll** | Alto (bordes extremos) | Muy bajo | **v2 gana** |

### Cuándo elegir cada una

- **v1** si se quieren centros más altos en 12-16 filas (0.75-0.80x vs 0.65-0.70x).
- **v2** si se priorizan **centros máximos en 8-10R** (0.82x vs 0.68-0.70x), **protección del bankroll**, y **curvas naturales**.

---

## 8. Valores para Deploy

### 8.1 — Smart Contract

```typescript
const MULTIPLIER_TABLES: Record<number, Record<number, bigint[]>> = {
  8: {
    0: [120n, 111n, 105n, 100n, 82n, 100n, 105n, 111n, 120n],     // RTP 97.02% ⭐ floor
    1: [346n, 229n, 139n, 79n, 55n, 79n, 139n, 229n, 346n],       // RTP 97.02%
    2: [566n, 331n, 164n, 63n, 30n, 63n, 164n, 331n, 566n],       // RTP 96.75%
  },
  10: {
    0: [115n, 110n, 106n, 103n, 100n, 82n, 100n, 103n, 106n, 110n, 115n],   // RTP 97.03% ⭐ floor
    1: [434n, 308n, 204n, 125n, 73n, 52n, 73n, 125n, 204n, 308n, 434n],     // RTP 96.83%
    2: [836n, 522n, 290n, 136n, 51n, 28n, 51n, 136n, 290n, 522n, 836n],     // RTP 97.00%
  },
  12: {
    0: [271n, 223n, 179n, 141n, 109n, 84n, 70n, 84n, 109n, 141n, 179n, 223n, 271n],       // RTP 96.97%
    1: [293n, 236n, 186n, 144n, 108n, 83n, 70n, 83n, 108n, 144n, 186n, 236n, 293n],       // RTP 96.98%
    2: [1187n, 788n, 480n, 258n, 115n, 41n, 22n, 41n, 115n, 258n, 480n, 788n, 1187n],     // RTP 96.99%
  },
  14: {
    0: [314n, 263n, 216n, 174n, 137n, 105n, 81n, 68n, 81n, 105n, 137n, 174n, 216n, 263n, 314n],       // RTP 96.96%
    1: [366n, 300n, 240n, 188n, 142n, 105n, 78n, 65n, 78n, 105n, 142n, 188n, 240n, 300n, 366n],       // RTP 96.80%
    2: [1575n, 1094n, 713n, 426n, 224n, 97n, 35n, 20n, 35n, 97n, 224n, 426n, 713n, 1094n, 1575n],     // RTP 97.01%
  },
  16: {
    0: [363n, 309n, 259n, 212n, 171n, 134n, 102n, 78n, 65n, 78n, 102n, 134n, 171n, 212n, 259n, 309n, 363n],       // RTP 97.02%
    1: [596n, 485n, 385n, 295n, 218n, 153n, 102n, 66n, 50n, 66n, 102n, 153n, 218n, 295n, 385n, 485n, 596n],       // RTP 97.00%
    2: [2031n, 1460n, 1000n, 641n, 375n, 193n, 83n, 31n, 20n, 31n, 83n, 193n, 375n, 641n, 1000n, 1460n, 2031n],   // RTP 96.98%
  },
};
```

### 8.2 — Frontend Fallback

```typescript
const FALLBACK_TABLES: Record<RowCount, Record<RiskLevel, number[]>> = {
  8: {
    low: [1.20, 1.11, 1.05, 1.00, 0.82, 1.00, 1.05, 1.11, 1.20],    // ⭐ floor
    medium: [3.46, 2.29, 1.39, 0.79, 0.55, 0.79, 1.39, 2.29, 3.46],
    high: [5.66, 3.31, 1.64, 0.63, 0.30, 0.63, 1.64, 3.31, 5.66],
  },
  10: {
    low: [1.15, 1.10, 1.06, 1.03, 1.00, 0.82, 1.00, 1.03, 1.06, 1.10, 1.15],  // ⭐ floor
    medium: [4.34, 3.08, 2.04, 1.25, 0.73, 0.52, 0.73, 1.25, 2.04, 3.08, 4.34],
    high: [8.36, 5.22, 2.90, 1.36, 0.51, 0.28, 0.51, 1.36, 2.90, 5.22, 8.36],
  },
  12: {
    low: [2.71, 2.23, 1.79, 1.41, 1.09, 0.84, 0.70, 0.84, 1.09, 1.41, 1.79, 2.23, 2.71],
    medium: [2.93, 2.36, 1.86, 1.44, 1.08, 0.83, 0.70, 0.83, 1.08, 1.44, 1.86, 2.36, 2.93],
    high: [11.87, 7.88, 4.80, 2.58, 1.15, 0.41, 0.22, 0.41, 1.15, 2.58, 4.80, 7.88, 11.87],
  },
  14: {
    low: [3.14, 2.63, 2.16, 1.74, 1.37, 1.05, 0.81, 0.68, 0.81, 1.05, 1.37, 1.74, 2.16, 2.63, 3.14],
    medium: [3.66, 3.00, 2.40, 1.88, 1.42, 1.05, 0.78, 0.65, 0.78, 1.05, 1.42, 1.88, 2.40, 3.00, 3.66],
    high: [15.75, 10.94, 7.13, 4.26, 2.24, 0.97, 0.35, 0.20, 0.35, 0.97, 2.24, 4.26, 7.13, 10.94, 15.75],
  },
  16: {
    low: [3.63, 3.09, 2.59, 2.12, 1.71, 1.34, 1.02, 0.78, 0.65, 0.78, 1.02, 1.34, 1.71, 2.12, 2.59, 3.09, 3.63],
    medium: [5.96, 4.85, 3.85, 2.95, 2.18, 1.53, 1.02, 0.66, 0.50, 0.66, 1.02, 1.53, 2.18, 2.95, 3.85, 4.85, 5.96],
    high: [20.31, 14.60, 10.00, 6.41, 3.75, 1.93, 0.83, 0.31, 0.20, 0.31, 0.83, 1.93, 3.75, 6.41, 10.00, 14.60, 20.31],
  },
};
```

---

## 9. Pasos para Implementar

1. Revisar y aprobar este documento
2. Actualizar `scripts/mainnet/set-plinko-multipliers.ts`
3. Actualizar `plinko-frontend/src/lib/multipliers.ts` (fallbacks)
4. Ejecutar: `npx hardhat run scripts/mainnet/set-plinko-multipliers.ts --network arbitrum`
5. Verificar en Arbiscan: `getMultipliers(8, 0)` debe devolver `[120, 111, 105, 100, 82, 100, 105, 111, 120]`
6. Monitorear RTP empírico en dashboard los primeros días

---

## 10. Riesgos

| Riesgo | Mitigación |
|--------|-----------|
| Bankroll no crece (break even) | Casa sigue ganando vía fees (1.5%) + referidos (1.5%) |
| 8R-10R Low bordes bajos (1.15-1.20x) | Es Low risk — la gracia es varianza baja; Medium/High conservan bordes altos |
| Menos emoción por premios extremos en Low | Bordes de Medium/High pagan 3x-20x; suficiente para feeling de "gran premio" |
| Centros de 12R-14R Medium suben poco (+8%, +12%) | Es lo máximo posible manteniendo curva suave |

---

## 11. Alternativa: RTP 96.5% (Compromiso)

| RTP | Bankroll net/bet | Centro 8R Low | ±1 8R Low | % no pierde |
|-----|:---:|:---:|:---:|:---:|
| 96.0% (actual) | +1.0% | 0.39x | 1.00x | 72.7% |
| **96.5%** | **+0.5%** | **~0.60x** | **1.00x** | **72.7%** |
| 97.0% (propuesto) | 0.0% | 0.82x | 1.00x | 72.7% |
