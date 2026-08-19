# Benchmark report

Cases: 10

| id | status (obs/exp) | outcome | modified | cmds | failed | tests | commits matched | skills | source bytes | est. tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| docs-reconciliation | accepted / accepted | no-test-evidence | 16 | 13 | 0 | 0 | 1 | 5 | 687118 | 171780 |
| sushi-reference | closed / closed | unresolved-failure | 24 | 38 | 3 | 8 | 1 | 6 | 889578 | 222395 |
| move-website | accepted / stable | unresolved-failure | 7 | 20 | 1 | 0 | 0 | 1 | 197264 | 49316 |
| invocation-ux-ut | user-testing / user-testing | no-test-evidence | 20 | 42 | 0 | 0 | 1 | 1 | 948426 | 237107 |
| nested-scroll-acc | accepted / accepted | no-test-evidence | 5 | 21 | 0 | 0 | 1 | 2 | 377688 | 94422 |
| cursor-regression | closed / closed | unresolved-failure | 5 | 91 | 5 | 0 | 1 | 4 | 881870 | 220468 |
| frozen-invocation | closed / closed | unresolved-failure | 10 | 90 | 1 | 10 | 2 | 4 | 2866395 | 716599 |
| cp38-plan | planned / planned | no-test-evidence | 3 | 17 | 0 | 0 | 0 | 2 | 547854 | 136964 |
| glassy-background | closed / closed | unresolved-failure | 2 | 24 | 1 | 0 | 0 | 3 | 2623806 | 655952 |
| invocation-card-position | accepted / stable | no-test-evidence | 10 | 42 | 0 | 0 | 2 | 2 | 3509340 | 877335 |

## Status evaluation
- docs-reconciliation: matched
- sushi-reference: matched
- move-website: matched
- invocation-ux-ut: matched
- nested-scroll-acc: matched
- cursor-regression: matched
- frozen-invocation: matched
- cp38-plan: matched
- glassy-background: matched
- invocation-card-position: matched

## Commit evaluation
- docs-reconciliation: matched 1 of 2 expected
- sushi-reference: matched 1 of 2 expected
- move-website: matched 0 of 0 expected
- invocation-ux-ut: matched 1 of 2 expected
- nested-scroll-acc: matched 1 of 2 expected
- cursor-regression: matched 1 of 2 expected
- frozen-invocation: matched 2 of 3 expected
- cp38-plan: matched 0 of 3 expected
- glassy-background: matched 0 of 0 expected
- invocation-card-position: matched 2 of 3 expected

## Context reduction
| id | source bytes | bundle bytes | summary bytes | source→summary reduction |
| --- | --- | --- | --- | --- |
| docs-reconciliation | 687118 | 111533 | 1687 | 407× |
| sushi-reference | 889578 | 174147 | 2791 | 319× |
| move-website | 197264 | 48400 | 1599 | 123× |
| invocation-ux-ut | 948426 | 56326 | 4250 | 223× |
| nested-scroll-acc | 377688 | 28986 | 1707 | 221× |
| cursor-regression | 881870 | 229105 | 1642 | 537× |
| frozen-invocation | 2866395 | 198278 | 2663 | 1076× |
| cp38-plan | 547854 | 35623 | 6655 | 82× |
| glassy-background | 2623806 | 89569 | 2339 | 1122× |
| invocation-card-position | 3509340 | 58289 | 4609 | 761× |

Token estimates use the ≈1 token per 4 bytes heuristic; they are not tokenizer output.
