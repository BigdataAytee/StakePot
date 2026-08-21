# The creation flow, before and after

Both sets at 390 × 844, the phone most Nigerian traffic arrives on.

## Before — five steps, forty rules printed

|                          |                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `before-1-question.png`  | Step 1 of 5. The question box, and a panel beside it waiting to print the checklist.                        |
| `before-2-outcomes.png`  | Step 2. Outcome labels, criteria, and edge cases as a textarea whose hint names six situations to type out. |
| `before-3-source.png`    | Step 3. Source, page, event date, void date — each with its rule numbers underneath.                        |
| `before-4-liquidity.png` | Step 4. L, expected stake, category, tags, icon, blockbuster.                                               |
| `before-5-review.png`    | Step 5. Attestations as two rule numbers, three judgement calls labelled "Rule 18", "Rule 25", "Rule R3".   |

The tab row does not fit across the screen; the page scrolls sideways.

## After — three steps and a review

|                               |                                                                                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `after-1-question-empty.png`  | "What's the question?" One box, the co-pilot, and the answers as a line of text.                                                                                        |
| `after-2-question-filled.png` | The same screen with a question in it, and the one rule currently failing said once, under the field that fixes it.                                                     |
| `after-3-settles-empty.png`   | "How does it settle?" Three fields. WAT is stamped on the time controls.                                                                                                |
| `after-4-settles-filled.png`  | Filled: the refund date arrived on its own, thirty days out, and the settlement wording composed from the source and the settle time — which is what satisfies rule 26. |
| `after-5-unusual.png`         | "Anything unusual?" Four edge cases pre-answered, one attestation toggle, sizing collapsed behind a default.                                                            |
| `after-6-review.png`          | The market as a trader meets it, then the verdict.                                                                                                                      |
| `after-7-review-answered.png` | Judgement calls answered; publish waiting only on the warning confirmation.                                                                                             |
| `after-8-review-expanded.png` | One click opens every rule in the register, including the ones nothing checked.                                                                                         |

Each step fits one screen: document height equals viewport height on all three,
and nothing scrolls sideways.

## What did not change

`packages/rules` runs unchanged, server-side, on review and again on publish.
`apps/web/src/app/admin/markets/__tests__/wizard-anchors.test.ts` fails the
build if any rule the wizard is responsible for loses the field that answers
for it.
