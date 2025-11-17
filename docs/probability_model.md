## Probability Model (Roulette + Progressive Jackpot)

### Purpose
- Provide a precise, contract-aligned probability model for the roulette and progressive jackpot system.
- Give equations for configuration, solvency, and sustainability planning.

### Notation and Units
- Basis points: `BPS = 10{,}000` (represents 100%).
- Multiplier scale: `MULTIPLIER_SCALE = 100` (e.g., 150 = 1.50x).
- Max replay depth: `MAX_ROLLS` (contract default 6).
- Per‑spin table parameters (roulette): house edge `h` (bps), replay `r` (bps), jackpot `j` (bps), contribution `c` (bps on net stake), chosen multiplier `m_h` (hundredths).
- Jackpot state: balance `J`, target balance for planning `J_{\text{target}}`.
- Bets: wager before fees `B`, worst‑case `B_{\max}`.

Unless otherwise stated, probabilities in equations appear as fractions in \([0,1]\), not bps. Convert with
\[
  p = \frac{p_{\text{bps}}}{\text{BPS}} \quad\Longleftrightarrow\quad
  p_{\text{bps}} = p \cdot \text{BPS}.
\]


### Roulette per‑spin model (SingleRandomRoulette)

Contract references:
- Probability derivation: `_deriveMultiplierProbability`.
- Spin resolution order per roll: Multiplier → Replay → Jackpot → Lose.
- Replays truncated to `MAX_ROLLS`.

#### Replay chain factor
Let \(\rho = r/\text{BPS}\) and \(R = \text{MAX\_ROLLS}\). The expected number of rolls in a chain (ignoring terminal lose caps) is the truncated geometric sum:
\[
  \mathbb{E}[N_{\text{rolls}}]
  \;=\; \sum_{k=0}^{R-1} \rho^k
  \;=\; \begin{cases}
    R, & r = \text{BPS} \\[4pt]
    \displaystyle \frac{1 - \rho^{R}}{1-\rho}, & 0 \le \rho < 1.
  \end{cases}
\]
The contract computes this in bps‑space as
\[
  \text{chainMultiplierBps} \;=\; \text{BPS} \cdot \sum_{k=0}^{R-1} \rho^k
  \;\approx\; \text{BPS}\cdot \frac{1-\rho^{R}}{1-\rho}.
\]

#### Adjusted RTP and multiplier win probability
Let base RTP (after house edge) be \(\text{RTP}_{\text{base}} = 1 - h/\text{BPS}\). The contract adjusts for replay using:
\[
  \text{RTP}_{\text{adj}} \;=\; \frac{\text{RTP}_{\text{base}}}{\sum_{k=0}^{R-1} \rho^k}
  \;\;=\;\; \frac{( \text{BPS} - h ) / \text{BPS}}{\text{chainMultiplierBps}/\text{BPS}}
  \;\;=\;\; \frac{(\text{BPS}-h)\cdot \text{BPS}}{\text{chainMultiplierBps}}.
\]
For a chosen payout multiplier \(m = m_h / \text{MULTIPLIER\_SCALE}\), the per‑roll multiplier win probability (bps) is:
\[
  p_{\text{mult,bps}} \;=\; \left\lfloor \frac{\text{RTP}_{\text{adj}} \cdot \text{MULTIPLIER\_SCALE}}{m_h} \cdot \text{BPS} \right\rfloor
  \;=\; \left\lfloor \frac{\text{RTP}_{\text{adj}} \cdot 100}{m} \right\rfloor.
\]

#### Threshold order and lose slice
Per roll the contract checks in order: Multiplier, then Replay, then Jackpot; any remainder is Lose:
\[
  p_{\text{lose,bps}} \;=\; \text{BPS} - p_{\text{mult,bps}} - r - j.
\]
Validity constraint (enforced with a small safety floor in code):
\[
  p_{\text{mult,bps}} + r + j \;\le\; \text{BPS}.
\]
If this would be exceeded, the implementation reduces \(j\) to maintain at least a 100 bps lose slice.

#### Multi‑roll resolution (finite horizon)
On each roll:
- With probability \(p_{\text{mult}} = p_{\text{mult,bps}}/\text{BPS}\): payout \(m \cdot B\) and stop.
- With probability \(\rho = r/\text{BPS}\): replay (continue), unless on the last roll where it resolves to Lose.
- With probability \(p_j = j/\text{BPS}\): trigger jackpot entry and stop.
- Else: Lose and stop.


### Jackpot trigger and outcome model (ProgressiveJackpot)

When Jackpot triggers, the game first contributes
\[
  C \;=\; \frac{c}{\text{BPS}} \cdot \text{netStake},
\]
then calls `processJackpotEntry(player, betAmount=B, roll)` with a uniform \( \text{roll} \in \{0,\dots,\text{BPS}-1\}\).

#### Outcome table as direct bps slices
Each registered game defines an ordered list of outcome slices with direct bps weights \(\{p_i^{\text{bps}}\}\) via `OutcomeConfig[]`. The contract computes cumulative thresholds and picks the first slice crossing `roll`. Any remainder \(\text{BPS} - \sum_i p_i^{\text{bps}}\) is the fallback “pure lose” slice.

- Tier award slices: exactly one slice corresponds to the current tier index (offset by `FIRST_TIER_OFFSET`). Only that slice yields a percent‑of‑balance or fixed tier prize when hit.
- Consolation slices: pay \( \text{mult}_i \cdot B \), where \(\text{mult}_i = \text{consolationMultiplier}_i / \text{BPS}\).
- Fallback: pays 0.

Slices can be static or scaled via `JackpotScalingLib` (concave/convex curves). In `ProgressiveJackpot`, scaling uses the current jackpot balance \(J\) as the metric, allowing probabilities to grow or taper with the pool.

Let \(p_{\text{tier}}\) be the fractional probability (0–1) of the current‑tier award slice, and \(\{(p_{\text{cons},i}, \text{mult}_i)\}\) the consolation slices.

The expected payout per jackpot entry at balance \(J\) and bet \(B\) is:
\[
  \mathbb{E}[\text{payout}\mid J,B] \;=\;
  p_{\text{tier}} \cdot \underbrace{\text{Prize}(J)}_{\text{fixed or } (k/10000)\cdot J}
  \;+\;
  \sum_i p_{\text{cons},i} \cdot \text{mult}_i \cdot B.
\]


### Cashflow planning and constraints

#### Per‑spin inflow vs outflow (sustainability)
Let \(p_j = j/\text{BPS}\) be jackpot trigger probability per roll. The expected jackpot outflow per spin is:
\[
  O \;=\; p_j \cdot \mathbb{E}[\text{payout}\mid J,B].
\]
The inflow per spin (from contributions) is:
\[
  I \;=\; \frac{c}{\text{BPS}} \cdot \text{netStake}.
\]
For conservative planning use \(B = B_{\max}\) and \(J = J_{\text{target}}\), and require sustainability:
\[
  I \;\ge\; O.
\]
Solving for the required contribution rate \(c\) (bps) using fractional probabilities:
\[
  \boxed{
  \frac{c}{\text{BPS}} \cdot B_{\max}
  \;\ge\;
  \frac{j}{\text{BPS}} \cdot
  \Big(
    p_{\text{tier}} \cdot \text{Prize}(J_{\text{target}})
    + \sum_i p_{\text{cons},i} \cdot \text{mult}_i \cdot B_{\max}
  \Big)
  }
\]
\[
  \Longrightarrow\;
  \boxed{
  c \;\ge\; j \cdot \left(
    p_{\text{tier}} \cdot \frac{\text{Prize}(J_{\text{target}})}{B_{\max}}
    + \sum_i p_{\text{cons},i} \cdot \text{mult}_i
  \right)
  }.
\]
If tiers are percent‑based with \( \text{Prize}(J) = (k/10000)\cdot J \), then
\[
  c \;\ge\; j \cdot \left(
    p_{\text{tier}} \cdot \frac{k}{10000} \cdot \frac{J_{\text{target}}}{B_{\max}}
    + \sum_i p_{\text{cons},i} \cdot \text{mult}_i
  \right).
\]

#### Solvency (no underfunded reverts)
The jackpot enforces solvency for the current tier award (when its slice hits) and for consolations:
\[
  J \;\ge\; \max\!\left\{ \text{Prize}(J),\;\; B \cdot \frac{\text{maxConsolationMultiplier}}{\text{BPS}} \right\}.
\]
For deployment with maximum allowed bet \(B_{\max}\), choose initial liquidity \(J_0\) with safety margin:
\[
  \boxed{
  J_0 \;\ge\; \max\!\left\{ \text{currentTierPrize},\;\; B_{\max} \cdot \frac{\text{maxConsolationMultiplier}}{\text{BPS}} \right\}.
  }
\]


### Mapping to contract parameters
- Roulette table (`SingleRandomRoulette.TableConfig`):
  - `replayBps = r`, `jackpotBps = j` (optionally scaled by stake), `jackpotContributionBps = c`,
    `minMultiplier`, `maxMultiplier`, `minWager`, `maxWager`.
- Roulette jackpot scaling (`setJackpotScalingConfig`): choose curve (Linear, Logarithmic, Exponential, Quadratic), and stake bounds for `j` in bps.
- Jackpot outcomes (`ProgressiveJackpot.registerGame`): ordered `OutcomeConfig[]` whose bps probabilities may scale with \(J\). Ensure the remainder (fallback) is pure lose.
- Jackpot tier ladder (`setTierLadder`): fixed prizes or percent‑based with optional terminal caps (contract caps terminal tier awards to ≤90% of balance).
- House edge and referral (`PaymentHandler`): `houseEdgeBps = h`, applied before computing `netStake` for contributions.


### Practical configuration ranges
- House edge \(h\): 300–700 bps (3–7%).
- Replay \(r\): ≤ 1000 bps (≤ 10%).
- Jackpot \(j\): 100–300 bps (1–3%) with optional stake scaling.
- Contribution \(c\): start 200–350 bps (2–3.5%), then validate with the sustainability inequality at \((B_{\max}, J_{\text{target}})\).
- Jackpot outcomes: keep total current‑tier award probability \(p_{\text{tier}}\) small (≈1–3%). Consolations 10–25% total with multipliers like 1.2x and 1.5x. Ensure cumulative probability ≤ BPS and define fallback.


### Sanity checklist (pre‑deploy or reconfigure)
1) Define \(B_{\max}, J_0, J_{\text{target}}\).\
2) Choose \(h, r, j, c\) and multiplier range \([m_{\min}, m_{\max}]\).\
3) Build outcome table: tier award slice for the current tier, consolation slices, and fallback = pure lose.\
4) Verify per‑roll constraint \(p_{\text{mult,bps}} + r + j \le \text{BPS}\) across the allowed multiplier range.\
5) Verify solvency bound for \(J_0\) at \(B_{\max}\).\
6) Validate sustainability \(I \ge O\) at \((B_{\max}, J_{\text{target}})\); adjust \(c\), \(j\), \(p_{\text{tier}}\), \(k\), or consolations as needed.\
7) Simulate (Monte‑Carlo) to confirm observed RTP, hit rates, and bankroll evolution.


### Notes
- In the jackpot, probabilities are direct bps slices summed cumulatively; the fallback slice implicitly takes the remainder.
- Only the “current tier” award slice pays a tier prize on hit; other tier slices are inert until the ladder index matches.
- The roulette implementation enforces at least a small Lose floor to avoid degenerate configurations.


