# The 43 rules, and the six red flags

Generated from `packages/rules/src/registry.ts`, which is the copy the code
reads. The prose lives in `docs/ticket-creation-checklist.md`; a CI test
(`packages/rules/src/__tests__/checklist-sync.test.ts`) fails if the two drift.

`R1`–`R6` are Part 6's red flags. They carry ids because the wizard surfaces
them as prompts to stop and think, not because software can detect them.

**Enforcement:** `block` refuses the publish · `warn` publishes with a flag a
person must read · `confirm` needs a human to attest · `monitor` is checked
after opening by the Part 5 sweep · `practice` is an operating habit with no
code behind it.

## Part 1 — the five non-negotiables

| #   | Rule                                     | Enforcement | Applies to            |
| --- | ---------------------------------------- | ----------- | --------------------- |
| 1   | One named official source                | `block`     | ai, wizard, community |
| 2   | An event date and a separate void date   | `block`     | ai, wizard, community |
| 3   | Complete, mutually exclusive outcomes    | `block`     | ai, wizard, community |
| 4   | Edge cases mapped in advance             | `block`     | ai, wizard, community |
| 5   | Nobody trading can influence the outcome | `block`     | ai, wizard, community |

## Part 2 — commercial rules

| #   | Rule                                                       | Enforcement | Applies to            |
| --- | ---------------------------------------------------------- | ----------- | --------------------- |
| 6   | Genuine disagreement — 35-65%                              | `warn`      | ai, wizard, community |
| 7   | Thresholds at consensus, not round numbers                 | `warn`      | ai, wizard            |
| 8   | Expect news flow before settlement                         | `warn`      | ai, wizard            |
| 9   | Emotional stakes                                           | `warn`      | ai, wizard            |
| 10  | Deadline close enough to hold attention                    | `warn`      | ai, wizard, community |
| 11  | Prefer multi-outcome where the story allows                | `warn`      | ai, wizard            |
| 12  | Round, memorable thresholds where they do not hurt balance | `warn`      | ai, wizard            |

## Part 3 — the forbidden list

| #   | Rule                                                           | Enforcement | Applies to            |
| --- | -------------------------------------------------------------- | ----------- | --------------------- |
| 13  | No death, injury, illness or harm                              | `block`     | ai, wizard, community |
| 14  | No crime, violence, terrorism or security incidents            | `block`     | ai, wizard, community |
| 15  | No private individuals or private matters                      | `block`     | ai, wizard, community |
| 16  | Nothing a participant can influence or has inside knowledge of | `block`     | ai, wizard, community |
| 17  | No outcome without a checkable official source                 | `block`     | ai, wizard, community |
| 18  | The front-page test                                            | `confirm`   | wizard, community     |
| 19  | No markets on the platform itself                              | `block`     | ai, wizard, community |
| 20  | Neutral wording on political events                            | `block`     | ai, wizard, community |

## Part 4 — craft and operations

| #   | Rule                                             | Enforcement | Applies to            |
| --- | ------------------------------------------------ | ----------- | --------------------- |
| 21  | Duplicate check before publishing                | `block`     | ai, wizard, community |
| 22  | Freeze at event start                            | `block`     | wizard, community     |
| 23  | Wording is final once open                       | `practice`  | wizard                |
| 24  | Size L to expected volume                        | `warn`      | wizard, community     |
| 25  | The stranger test                                | `confirm`   | wizard, community     |
| 26  | State the timezone and the hour                  | `block`     | ai, wizard, community |
| 27  | First-published-figure rule                      | `block`     | ai, wizard, community |
| 28  | Name the exact metric                            | `block`     | ai, wizard, community |
| 29  | State currency, unit and rate window             | `block`     | ai, wizard, community |
| 30  | Icon, category and tags set                      | `warn`      | wizard, community     |
| 31  | Launch timing                                    | `warn`      | ai, wizard            |
| 32  | Recurring markets: refresh thresholds each cycle | `warn`      | wizard                |
| 33  | Check the calendar for collisions                | `warn`      | wizard                |
| 34  | Do not over-list                                 | `warn`      | wizard                |

## Part 5 — after publishing

| #   | Rule                                                      | Enforcement | Applies to |
| --- | --------------------------------------------------------- | ----------- | ---------- |
| 35  | Watch the split for 48 hours                              | `monitor`   | monitor    |
| 36  | Watch for one-sided whale entry                           | `monitor`   | monitor    |
| 37  | Pin news as the story develops                            | `practice`  | monitor    |
| 38  | Prepare the resolution before the event ends              | `monitor`   | monitor    |
| 39  | Resolve promptly                                          | `monitor`   | monitor    |
| 40  | Never resolve alone                                       | `practice`  | monitor    |
| 41  | Honour the dispute window even when the result is obvious | `practice`  | monitor    |
| 42  | Void cleanly and loudly                                   | `practice`  | monitor    |
| 43  | Log the post-mortem                                       | `monitor`   | monitor    |

## Part 6 — red flags

| #   | Rule                                               | Enforcement | Applies to            |
| --- | -------------------------------------------------- | ----------- | --------------------- |
| R1  | You had to explain it twice                        | `practice`  | ai, wizard            |
| R2  | You cannot name the exact webpage                  | `block`     | ai, wizard, community |
| R3  | You are hoping a particular side wins              | `confirm`   | wizard                |
| R4  | The interesting part is how, not whether           | `practice`  | ai, wizard            |
| R5  | You are unsure whether it is on the forbidden list | `practice`  | ai, wizard, community |
| R6  | The appeal depends on a rumour                     | `block`     | ai, wizard, community |
