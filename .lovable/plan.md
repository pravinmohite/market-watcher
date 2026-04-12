

## Fix: Add Double Decay Recheck After Sideways Pause Expires

### Problem
When the 15-minute sideways pause expires (lines 1342-1365), the bot only checks if Nifty has moved ≥30 pts. It does **not** re-check whether both CE and PE premiums are still in double decay. On expiry days, Nifty can move 30+ pts while theta crushes both premiums, causing the bot to resume into a losing environment.

### Solution
After the pause expires and Nifty movement passes the threshold, also fetch current OTM CE/PE prices and compare them against the session's premium anchors (same logic as `shouldSkipNextRound`). Only resume if double decay is **not** present. If premiums are still both decaying, re-pause for another 15 minutes.

### Changes

**File: `supabase/functions/martingale-bot/index.ts`**

In the post-pause recheck block (around lines 1342-1365):

1. **After confirming Nifty moved ≥30 pts** (line 1360, after the existing range check passes), add a double decay recheck:
   - Extract current OTM CE and PE prices from `optionData` (already fetched at line 1343)
   - Find the most recent completed session to get premium anchors via `getSessionPremiumAnchors`
   - Check if both CE and PE premiums have decayed > 3% (using `SIDEWAYS_PREMIUM_DECLINE_RATIO`)
   - If both are still decaying → update pause spot, re-pause 15 min, send Telegram notification, return early
   - If not both decaying → proceed with cleanup and auto-start (existing flow)

2. **Updated flow after pause expires:**

```text
Pause expires
  → Fetch fresh option chain data
  → Check 1: Nifty moved ≥30 pts from stored spot?
      NO  → re-pause 15 min (existing logic)
      YES → Check 2: Both OTM CE & PE still in double decay?
              YES → re-pause 15 min (NEW)
              NO  → resume trading (existing logic)
```

### Technical Details

- Reuses existing `getSessionPremiumAnchors()` function and `SIDEWAYS_PREMIUM_DECLINE_RATIO` constant
- OTM CE/PE prices are extracted from the already-fetched `optionData` (ATM strike ± 1 step)
- No new database columns or tables needed
- Telegram notification will distinguish between "Nifty range too small" and "Double decay still active" re-pauses

