# Goal Handoff

For long execution, hand the user a one-paste goal condition that requires:

- `DW_RUN_START`
- one verify/done marker group per executed step
- `DW_REVIEW_COMPLETE ok`
- `DW_RUN_COMPLETE`

Do not mark a dynamic workflow complete without `DW_RUN_COMPLETE`.
