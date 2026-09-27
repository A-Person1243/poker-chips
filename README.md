# Poker Chips

A mobile-friendly shared poker chip and action tracker for in-person home games. One person creates a table, friends join with a six-character room code or invite link, and everyone sees stacks, turns, bets, pots, folds, all-ins, and payouts update in real time.

## Features

- Create a room with a custom starting stack
- Join from any phone with a room code or link
- Real-time synchronized stacks and pot
- Host-editable table / turn order
- First player to act starts the betting cycle; action then moves automatically around the configured order
- Context-aware poker actions: **Check, Call, Bet, Raise, Fold, All in**
- Calls automatically cap at a player's stack
- Minimum no-limit raise size is enforced
- Short all-in raises are supported and do not incorrectly reopen raising for players who already acted
- Per-round and per-hand contribution tracking
- Automatic main-pot and side-pot calculation
- Showdown settlement by finishing place: enter `1`, `2`, `3`, etc.; equal places create a split pot
- Folded players' committed chips remain in pots but folded players cannot win them
- Host controls for rebuys / corrections
- Player-to-player **Donate chips** transfer
- Players who join after a hand has started automatically wait until the next hand
- Recent activity feed
- Firebase Anonymous Authentication; no player account setup
- Static site: deploys cleanly to GitHub Pages

> **Important:** this is a trust-based tracker for casual in-person games. It does not process money or payments. The included Firebase rules prioritize easy friend-group setup and are **not appropriate for adversarial users or real-money wagering**. A technically knowledgeable authenticated user who knows a room code could modify room data directly.

## How betting works

At the beginning of each betting round, there is no forced first actor in the app. Any active player can make the first action. From that player onward, action advances automatically through the host's configured table order.

After a bet or full raise, every other eligible player must respond before the round ends. Calls, folds, checks, and all-ins are handled according to the current bet and the player's remaining stack. The host can then select **Next betting round** to reset only the round-level betting amounts while preserving total hand contributions for side-pot calculations.

The app intentionally does not deal cards, determine hand strength, or enforce dealer/blind positions. You still play poker at the table; Poker Chips manages chips and action state.

## Main pots, side pots, and split pots

Every chip placed into the pot is stored as part of that player's total contribution for the current hand. At showdown:

1. The host enters finishing places for players who have not folded.
2. `1` is best, `2` is second, and so on.
3. Give multiple players the same place to represent a tie.
4. Press **Settle pots from places**.

The app creates pot layers from contribution amounts. For each layer it only considers players who contributed enough to be eligible for that layer, ignores folded players, finds the best entered place among the eligible players, and awards/splits that pot automatically.

If an indivisible chip remains after an equal split, the extra chip is awarded according to the configured turn order so that the result is deterministic.

### Example

- Alice: 100 all-in
- Bob: 300 all-in
- Carol: 300 all-in

The app creates:

- Main pot: 300 (Alice/Bob/Carol eligible)
- Side pot: 400 (Bob/Carol eligible)

If the host enters Alice = `1`, Bob = `2`, Carol = `3`, Alice gets the 300 main pot and Bob gets the 400 side pot.

If Bob and Carol are both entered as `1`, they split every pot for which both are eligible.

## Donate chips

The **Donate chips** control transfers chips directly from your available stack to another player's available stack. It does **not** add chips to the pot or alter either player's recorded hand contribution. To avoid changing stack availability in the middle of a betting sequence, donations are enabled before action begins or after the current hand has been settled.

## Typical hand flow

1. Host puts everyone in the correct table order using the arrow buttons.
2. A player makes the first action of the betting round.
3. Pocket Chips automatically prompts each next player with only the actions that are currently legal for them.
4. When the betting round finishes, the host can start another betting round.
5. At showdown the host enters finishing places for the remaining players.
6. Pocket Chips calculates and awards every main/side/split pot.
7. The host starts the next hand.

## Notes / intentionally out of scope

Pocket Chips does not know the cards, evaluate poker hands, automatically post blinds, or choose who should act first on a street. Those rules vary by game and dealer/button position. The host controls the circular table order, and whichever player begins a betting round establishes the first point in that action cycle.

## License

MIT
