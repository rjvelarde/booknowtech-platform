# GitHub Branch Protection Baseline

Repository administrators must protect `main` with:

- pull requests required before merge;
- at least one approval and dismissal of stale approvals;
- conversation resolution required;
- force pushes and deletion disabled;
- required checks `Quality and tests` and `Secret scan`;
- the branch required to be current before merge;
- direct administrator bypass disabled except documented incident procedure.

CI uses no production credential or database. Any vulnerability at or above the configured blocking severity must be corrected or receive an approved, expiring Engineering Playbook exception.
