# Moola Development Protocol & Constraints

This document is the **Source of Truth** for the Moola project. It must be read before any structural changes to `index.html`.

## 1. Core Product Logic (The "Future" Engine)

### **The Age 25 Anchor (Strict)**
- **Baseline**: Projections **MUST** be anchored to the user's Current Age (default: 25).
- **Starting Net Worth**: The compounding logic begins exactly at Age 25 using the synced `nwTotal()` or manual override.
- **Historical Years**: Any row *before* the current age is a manual-only scratchpad. Data entered there **must not** compound forward or affect the future wealth trajectory.

### **Manual Overrides (Priority Map)**
- **Net Worth Overrides**: If a user enters a manual Net Worth in the projection table, it becomes the **new "hard" baseline** for all subsequent years.
- **Income Overrides**: Job income overrides should still grow at the defined growth rate.

### **Persistence**
- All state changes (Income, Properties, Events, Overrides) must be synchronized via `ps()` (persist) and `ls()` (local sync).
- NEVER skip persistence after updating the `ftOvMap` or `ftGlobals`.

---

## 2. Technical Guardrails (Monolithic File Safety)

### **Anti-Duplication Rule**
- The application is a massive single-file HTML. **NEVER** define core engine functions (`ftCalcRows`, `ftGetTodayNW`, `ftCalcPropSchedule`, etc.) more than once.
- Before adding a function, use `grep_search` to verify if it already exists.

### **Syntax Integrity**
- Because the script block is large, a single misplaced brace `{}` or fragment like `.max()` will break the **entire app**.
- **Constraint**: When using `replace_file_content`, always check 20 lines above and below the target to ensure you are not leaving fragmented function tails.

### **Mandatory Dependency Audit (CRITICAL)**
> **This rule exists because the entire Future tab was broken by ignoring it.**

Before modifying or removing ANY block near the Future engine, run this grep and verify ALL of the following functions are still defined exactly once:
```
grep -n "function ftGetPhase\|function ftGetIncome\|function ftGetPartnerIncome\|function ftGetLiving\|function ftGetRent\|function ftCalcPropMortgage\|function ftCalcPropSchedule\|function ftCalcRemainingDebt\|function ftHas401kEligible\|function ftGetTodayNW\|function ftCalcRows\|function requiredSavingsForGoal" index.html
```
If any of these are missing → **STOP. Do not ship. Restore from git history immediately.**

### **Git History Recovery Rule**
- If a tab is blank after an edit, the most likely cause is a silent function deletion.
- Run `git show <PREV_COMMIT>:index.html > old.html` and grep the old file to recover the lost functions.
- **NEVER attempt to rewrite deleted logic from memory.** Always recover from git.

---

## 3. UI & Layout Philosophy

- **Vertical Flexibility**: Never box primary content (like the Projection Table) into a fixed-height container. Cards and components MUST "hug" their content vertically (`height: auto`) to allow for full-page natural scrolling.
- **Hover Reveal**: Use hover-to-reveal patterns for secondary controls (like row/column deletion) to maintain a clean, premium "dashboard" aesthetic.
- **Timeline Management**: 
    - Users must be able to add/delete rows from the top (History) or bottom (Max Age).
    - Functional "Reset" buttons for overrides should be easily accessible but non-intrusive.

---

## 4. Specific Engine Edge Cases

- **Salary Overrides & Growth**: If a user enters a manual "Monthly Take-home" override for a job, that value **MUST** still be multiplied by the job's growth rate in future years. It is a "corrected baseline," not a fixed constant.
- **Goal Feasibility**: If Discretionary Budgeting is $0, it signifies that goals are mathematically impossible. The engine must strictly reflect this reality without "fudging" numbers.
- **Liquid NW Calc**: When applying a Net Worth override, the `liquidNW` is calculated as `TotalOverride - RealEstateEquity`.

---

## 5. Heritage & Code Preservation

- **Account Switcher**: There is a substantial amount of commented-out code for an "Account Switcher" and multi-user filtering. **DO NOT DELETE** this during refactors; it is preserved for future re-activation.
- **Monolithic Script**: The `<script>` block in `index.html` is the primary logic engine. Significant logic chunks (like `renderOverview` or `renderAccounts`) are highly interdependent—audit them before any major re-writes.

---

## 6. Current Architecture Map
- **Persistence**: Supabase + LocalStorage.
- **Engine**: `ftCalcRows()` is the heart of the "Future" tab.
- **Events**: `ftLifeEvents`, `ftIncomeStreams`, `ftProperties`.
- **UI State**: `ftActiveScenarioId` manages multiple financial simulations.

### Critical Function Dependency Chain (Future Tab)
These functions must ALL be present and in this order for the Future tab to render:
1. `ftGetPhase` → phase lookup
2. `ftGetPhaseOverlaps` → overlap detection for phase cards  
3. `ftPrimaryHomeAgeRange` → mortgage vs. rent logic
4. `ftHas401kEligible`, `ftGetStreamIncome`, `ftGetIncome` → income math
5. `ftGetPartnerIncome` → partner income with override chain
6. `ftGetLiving`, `ftGetRent` → expense math (inflation-adjusted)
7. `ftCalcPropMortgage`, `ftCalcPropSchedule`, `ftCalcRemainingDebt` → mortgage math
8. `ftCalcMortgage`, `ftCalcMortgageSchedule` → legacy aliases (keep for event cards)
9. `requiredSavingsForGoal` → goal-based savings engine
10. `ftGetTodayNW` → NW baseline anchor
11. `ftCalcRows` → main projection loop (calls all of the above)

> **Any gap in this chain = blank Future tab.**
