# Moola Projection Engine Mathematics

This document serves as the mathematical source of truth for the Moola projection engine. It defines the specific equations dictating how each variable in the projection timeline is calculated, the lifecycle of edge cases (like history vs. future), and how life events interplay with calculations.

## 1. Income & Taxes

### Total Gross Income
**Definition:** The sum of all active streams, partner income, and social security.
**Equation:**
`Total Gross = Σ(Active Income Streams) + Partner Income + Investment Property Rental Income + Social Security`
*   **Income Streams:** Adjusted annually by `Math.pow(1 + streamGrowthRate, age - startAge)`. If there is a manual cell override for a "salary" stream, that stream's base is completely replaced for that year, and future growth re-anchors to that override.
*   **Partner Income:** Added only when `age >= Partner Event Start Age`. Stays constant unless an income growth rate is set, and drops to $0 when `age >= Partner Retire Age`.
*   **Social Security:** Added only when `age >= Social Security Claim Age` (and SS is globally enabled). Calculated as `SS Benefit * 12`. 

### Net Take-Home (NetHH)
**Definition:** The actual spendable cash landing in liquid accounts after taxes and pre-tax deductions (like 401k).
**Equation:**
`Net Take-Home = (Taxable Gross - Marginal Taxes) + Fixed Net Streams (e.g. Passive/Take-Home Overrides)`
*   **401k Deduction:** Before taxes, `min(eligibileSalary, 401kLimit)` is deducted from `Taxable Gross`.
*   **Taxes:** Computed using marginal US federal brackets + standard deduction + flat state tax rate.
*   **Marriage:** When a partner event occurs (e.g., at age 31), the projection immediately applies the "Married Filing Jointly" tax bracket for the *entire year*, accurately reflecting US tax rules (which define marital status based on Dec 31st).
*   **Take-Home Overrides:** If an income stream has a manual "Take-Home Override", it bypasses the tax engine entirely and is treated as a "Fixed Net Stream" added directly to bottom-line liquidity.

## 2. Fixed Expenses

### Adjusting for Global Inflation
All base-level, ongoing living inputs are assumed to represent *today's dollars*.
**Equation:** `Inflation Factor = Math.pow(1 + Global Inflation Rate, Age - Projection Starting Age)`

### Adjusted Living
**Definition:** General life operating costs (groceries, leisure, utilities).
**Equation:** `Living = Monthly Living Input * 12 * Inflation Factor`
*   **Phase Mapping:** Derived from the current active Life Phase for any given age.

### Housing Outflow
**Definition:** Rent + Mortgages + Real Estate Down Payments.
**Equation:** `Housing = Rent (if renting) + Σ(Active Mortgages) + Down Payments (if purchase year)`
*   **Transition to Ownership:** If an active primary property is fully purchased, Rent is explicitly forced to `$0`, completely overriding the active Life Phase's rent setting.
*   **Down Payments:** In the exact year of a property purchase, `(Purchase Price * Down%) + (Purchase Price * 3% Closing Costs)` is added as a massive, one-time Housing outflow.

### Kids & Healthcare
**Definition:** Dependent and medical life-cycle costs.
**Equation:** `Kids = Phase Annual Cost * Inflation Factor`
*   **Kids:** Costs map to specific child ages (e.g., Preschool, College). The parent's age is subtracted by the Child Event age to find the child's current age. The matching phase cost is then applied.
*   **Healthcare:** Directly maps to a start/end age bracket and is multiplied by the `Inflation Factor`.

## 3. Discretionary Outflows

### One-Time Events (`ot`)
**Definition:** Large, lumpy, miscellaneous inflows/outflows (e.g., weddings, inheritances, medical bills).
*   Added exactly in the target year. Evaluates as a direct negative (or positive for windfalls) modifier to the `Net Savings` variable to realistically deplete/augment net liquid cash for that year.

## 4. Savings & Goal Targeting

### Net Savings
**Definition:** The absolute change in cash from operating workflows *before* compound market growth is applied.
**Equation:**
`Net Savings = Net Take-Home - Adjusted Living - Fixed Costs (Housing + Kids + Healthcare) + One-Time Events`
*   A negative `Net Savings` directly pulls from the liquid portfolio, mathematically reducing investment growth in the subsequent year.

### Required Savings (Goal Tracking)
**Definition:** The exact yearly savings rate mathematically required to hit the *chronologically nearest* future financial target based on current market return assumptions.
**Equation (Nearest-Goal First):** 
1. The engine aggregates all active goals: Retirement NW, Property Down payments, One-time costs, Child College targets.
2. It sorts them chronologically by `targetAge`.
3. It selects the *closest* goal.
4. `Required Savings = Shortfall * RoC / ((1 + RoC)^YearsRemaining - 1)` (Using Time-Value-of-Money Annuity Formula).
*   **Downstream Warning:** If saving strictly at this nearest-goal rate places the portfolio mathematically short of a larger, later goal (e.g., affording a $50k car today means failing a $5m retirement tomorrow), a warning is appended to the UI flagging the downstream shortfall.

### Max Discretionary Allowance (Free Spend)
**Definition:** How much cash you can technically afford to blow freely each month while still perfectly hitting your goals.
**Equation:**
`Free Spend = (Net Take-Home - Fixed Costs - Required Savings) / 12`

### Monthly Surplus
**Definition:** How much cash you are *actually* depositing into liquid savings compared to the bare minimum goal requirement.
**Equation:**
`Monthly Surplus = ((Net Take-Home - Fixed Costs - Actual Living) - Required Savings) / 12`
*   If Surplus is negative, it means your actual lifestyle (Living costs) is preventing you from reaching your minimum required goal rhythm.

## 5. Accumulators (Net Worth)

### Compound Growth
Accounts grow at the user's defined Global Return on Capital (RoC).
*   **Liquid NW (Next Year) =** `Previous Liquid NW * (1 + RoC) + Net Savings - Extra Prop Payments`
*   **Retirement 401k (Next Year) =** `Previous Ret NW * (1 + RoC) + Annual 401k Contributions`
*   **Real Estate Equity =** `Market Value - Remaining Mortgage Principal`
    *   `Market Value = Purchase Price * (1 + Prop Appreciation Rate)^Years Owned`
    *   `Remaining Principal` is amortized mathematically based on term, rate, and specific lump-sum extra payment schedules.

### Total Net Worth
**Equation:** `Total NW = Liquid NW + Retirement + Real Estate Equity`
*   **Overrides:** If a manual historical or future "Override" cell is entered for Total NW, Moola reverse-calculates `Liquid NW = Override Total NW - Retirement - Real Estate Equity`. This ensures structural assets continue calculating accurately, but forces the overall balance to match the bank statement exactingly.
