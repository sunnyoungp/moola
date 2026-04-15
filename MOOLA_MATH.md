# MOOLA_MATH.md — Projection Engine Reference

> Canonical equations for every column in the Moola projection table.
> Detailed enough to fact-check any cell without reading source code.
> Last updated: 2026-04-15 (reflects all fixes through session 65057b12)

---

## Global Constants

| Symbol | Source | Description |
|--------|--------|-------------|
| `RoC` | Settings → Growth Rate | Annual portfolio return rate (e.g. 0.06 for 6%) |
| `inf` | Settings → Expense Inflation | Annual cost inflation rate (e.g. 0.025 for 2.5%) |
| `curAge` | Settings → Your Age | Projection starting age |
| `τ` | Auto or flat rate | Effective tax rate for the year |

---

## 1. Income Column (`gross income`)

### Active Income Streams
Each income stream `s` contributes for years in `[s.startAge, s.endAge]`:
```
streamIncome(s, age) = s.annual × (1 + s.growthRate)^(age − s.startAge)
```
If a **manual cell override** exists for the first salary stream at year `X`:
```
streamIncome(s, age > X) = override(X) × (1 + s.growthRate)^(age − X)   [re-baselined]
```
If a stream has a **take-home override**, it bypasses the tax engine entirely and is treated as a post-tax fixed net stream.

### Partner Income
Added when `age ≥ partnerEventAge`. Drops to $0 when `age ≥ partnerRetireAge`.
```
partnerIncome(age) = partnerBaseIncome × (1 + partnerGrowthRate)^(age − partnerEventAge)
```

### Rental Income (Investment Properties)
```
rentalIncome(p, age) = p.rentalMonthly × 12 × (1 + p.rentalGrowth)^(age − p.purchaseAge)
```
Active only when `age ≥ p.purchaseAge`.

### Social Security ✦ Fixed (post-fix)
Added when `ssEnabled = true` AND `age ≥ ssClaimAge`:
```
ssIncome = ssBenefit × 12
```
> **Previously bugged:** SS was only in `ftGetIncome()` helper, which was never called in the projection loop. Now injected directly into the loop.

### Total Gross Income
```
grossIncome = Σ(streamIncome) + partnerIncome + Σ(rentalIncome) + ssIncome
```

---

## 2. Tax Calculation

### 401k Deduction (pre-tax)
```
contrib401k = min(eligibleGross, annualLimit)    [if any stream is 401k-eligible]
```

### Taxable Income
```
taxableIncome = grossIncome − contrib401k
```

### Tax Rate (`τ`)
- **Auto mode:** US marginal federal bracket + standard deduction + flat state rate
- **Manual mode:** `ftGlobals.taxFlat / 100`
- **Filing status:** Joint (`married = true`) when `age ≥ partnerEventAge`. The full joint bracket applies for the entire year of the partner event — this is correct per IRS rules (status determined on Dec 31).

### Net Take-Home (`netHH`)
```
netHH = (taxableIncome − taxableIncome × τ) + fixedNetStreams
```
Where `fixedNetStreams` = take-home-override streams + SS income (not taxed through the engine) + partner take-home override.

---

## 3. Expenses

### Inflation Factor
All expense inputs are entered in **today's dollars**. The engine inflates them from `projectionStartingAge`:
```
infFactor(age) = (1 + inf)^(age − curAge)
```

### Living (`living`)
```
living(age) = activePhase.monthlyLiving × 12 × infFactor(age)
```

### Housing (`housing`)
Three components — only one active at a time for primary housing:

| Situation | Housing value |
|-----------|---------------|
| Renting, no property | `phase.monthlyRent × 12 × infFactor(age)` |
| Primary mortgage active | `annualMortgagePayment` (fixed, no inflation) |
| Mortgage paid off | `$0` |
| Property purchase year | `housing + (price × downPct% + price × 3%)` as spike |

> **Transition rule:** Once a primary property is purchased (`age ≥ purchaseAge`), rent is forced to $0 regardless of phase settings.

### Kids ✦ Fixed (post-fix)
```
kids(age) = matchedStage.annual × infFactor(age)
```
Stage matched by `childAge = age − childEventAge`. **Previously not inflated.**

### Healthcare ✦ Fixed (post-fix)
```
healthcare(age) = Σ(activeEvents.monthlyCost × 12 × infFactor(age))
```
Active when `he.startAge ≤ age ≤ he.endAge`. **Previously not inflated.**

### Fixed Costs
```
fixedCosts = housing + kids + healthcare
```

---

## 4. One-Time Events (`ot`)

One-time events are large lumpy inflows or outflows entered at a specific age:
```
ot(age) = Σ(oneTimeEvents where event.age === age, event.amount)
```
Positive = windfall. Negative = expense.

> **Included in `netSavings`** — see below.

---

## 5. Net Savings ✦ Fixed (post-fix)

```
netSavings = netHH − living − fixedCosts + ot
```

> **Previously bugged:** `ot` was NOT included. `netSavings` only reflected operating cash flow, ignoring one-time events. This caused NW to jump/drop without explanation in the net savings column. Now `ot` is part of `netSavings`, so the column reflects the true annual change in liquid wealth.

---

## 6. Goal Tracking — Required Savings ✦ Fixed (post-fix)

### Nearest-Goal-First Logic
All upcoming goals are collected into a priority queue, sorted by `targetAge ASC`. The chronologically **nearest** goal drives `requiredSavings`:

```
yearsRemaining = targetAge − age
shortfall      = targetNW − currentBase × (1 + RoC)^yearsRemaining

requiredSavings = shortfall × RoC / ((1 + RoC)^yearsRemaining − 1)   [if RoC > 0]
               = shortfall / yearsRemaining                             [if RoC = 0]
```

> **Previously bugged:** Binding goal was selected by highest `req` value, not nearest date.

### Goal Bases by Type

| Goal type | `currentBase` used |
|-----------|-------------------|
| **Retirement** | `retirementGoalBase = liquidNW + retirementBal` |
| **Property down payment** | `effectiveLiquidNW = liquidNW` (liquid only) |
| **One-time large purchase** | `effectiveLiquidNW` |
| **College** | `effectiveLiquidNW` |

> **Retirement base fix:** Previously used `investableNW = liquidNW + retirementBal + investmentPropertyEquity`. Investment property equity grows at ~4% appreciation, not portfolio RoC, so projecting it at RoC understated required savings. Now excluded.

### Downstream Shortfall Warning
After binding goal is selected, all later goals are forward-projected assuming current `requiredSavings` rate. If any later goal falls short:
```
projected = currentBase × (1 + RoC)^yrs + requiredSavings × ((1 + RoC)^yrs − 1) / RoC
```
A ⚠ warning is appended to the `discTooltip` and surfaces in the Required Savings hover card.

### Rate Mode
If `discMode = 'rate'`: `requiredSavings = netHH × savingsRate%`

---

## 7. Discretionary Budget / Free to Spend

```
rawFreeSpend = (netHH − fixedCosts − requiredSavings) / 12
freeSpend    = max(0, rawFreeSpend)
```

When `rawFreeSpend < 0`: a ⚠ Diagnostic Alert shows on hover — real `rawFreeSpend` is negative (structural deficit).

---

## 8. Net Worth Accumulators

### Liquid NW
```
liquidNW(age) = prevLiquid × (1 + RoC) + netSavings − extraMortgagePayments
```
> Note: `netSavings` already includes `ot` (one-time events), so `ot` is NOT separately added here.

**Override behavior:** If user enters a total NW for year `Y`, the engine reverse-derives:
```
liquidNW(Y) = nwOverride(Y) − retirementBal(Y) − realEstateEquity(Y)
```

### Retirement Balance
```
retirementBal(age) = retirementBal(age−1) × (1 + RoC) + contrib401k
```
Seeded from `ftGetRetirementBal()` at `curAge`.

### Real Estate Equity
```
marketValue(p, age) = p.price × (1 + p.appreciationRate)^(age − p.purchaseAge)
equity(p, age)      = marketValue(p, age) − remainingMortgagePrincipal(p, age)
realEstateEquity    = Σ equity(p, age)   [all owned properties]
```
Remaining principal is amortized using the standard mortgage formula, accounting for any lump-sum extra payments.

### Total Net Worth
```
nw = liquidNW + retirementBal + realEstateEquity
```

### Investable NW (used for retirement 4% rule only)
```
investableNW = liquidNW + retirementBal + investmentPropertyEquity
```
Excludes primary home equity (illiquid). Includes investment properties because their equity can be liquidated. Used **only** for the 4% rule withdrawal calculation in retirement — not for goal savings calculations.

---

## 9. Retirement Spending (Post-Retirement)

When `age > retireAge`, the table switches from savings-mode to withdrawal-mode.

### 4% Rule
```
monthlyBudget = max(0, investableNW × 0.04 / 12)
```

### Inheritance Goal Mode
```
spendable      = max(0, investableNW × (1+RoC)^yearsLeft − inheritanceTarget)
annualWithdraw = spendable × RoC / ((1+RoC)^yearsLeft − 1)
monthlyBudget  = max(0, annualWithdraw / 12)
```

---

## 10. Overrides

| Column | Override behavior |
|--------|-----------------|
| `net worth` | Total NW is pinned; liquid portion is back-derived as `nwOv − retirementBal − realEstateEquity` |
| `gross income` | Replaces the first salary stream's value for that year; future years re-baseline growth from it |
| `partner` | Replaces partner income for that year only |

Double-click any overridable cell to clear it.

---

## 11. Column Quick Reference

| Column | Formula (simplified) |
|--------|----------------------|
| gross income | `Σ streams + partner + rental + SS` |
| net savings | `netHH − living − fixedCosts + ot` |
| housing | `mortgage OR rent + down-payment spike` |
| kids | `stageAnnual × infFactor` |
| healthcare | `monthlyCost × 12 × infFactor` |
| required savings | `shortfall × RoC / ((1+RoC)^yrs − 1)` for nearest goal |
| free to spend | `max(0, (netHH − fixedCosts − reqSavings) / 12)` |
| net worth | `liquidNW + retirementBal + realEstateEquity` |
| retirement bal | `prevBal × (1+RoC) + contrib401k` |
| real estate equity | `marketValue − remainingPrincipal` |
