# Environment Inventory Template

Store this record in the restricted operator system. Record secret fingerprints only—never values.

| Field                                | Staging                         | Production               |
| ------------------------------------ | ------------------------------- | ------------------------ |
| Railway project ID                   |                                 |                          |
| Railway environment UUID             |                                 |                          |
| Railway environment name             | `staging`                       | `production`             |
| Frontend service/deployment ID       |                                 |                          |
| API service/deployment ID            |                                 |                          |
| Worker service/deployment ID         |                                 |                          |
| Approved Git SHA                     |                                 |                          |
| Previous known-good SHA              |                                 |                          |
| Administrative hostname              | `admin.staging.booknowtech.com` | `admin.booknowtech.com`  |
| Tenant wildcard                      | `*.staging.booknowtech.com`     | `*.booknowtech.com`      |
| Atlas project/cluster                |                                 |                          |
| MongoDB database                     | `booknowtech_staging`           | `booknowtech_production` |
| MongoDB runtime username             |                                 |                          |
| MongoDB URI fingerprint              |                                 |                          |
| Postmark server ID                   |                                 |                          |
| Postmark sender                      |                                 |                          |
| Postmark token fingerprint           |                                 |                          |
| Appointment token-secret fingerprint |                                 |                          |
| Rate-limit secret fingerprint        |                                 |                          |
| Release operator and time            |                                 |                          |
| QA evidence location                 |                                 |                          |
| Rollback deployment IDs              |                                 |                          |

Required attestations:

- [ ] The current staging environment contains no real production traffic or paying customers.
- [ ] No payment integration or credentials are part of this task.
- [ ] Production was created empty and was not cloned from staging.
- [ ] Cross-environment Atlas access tests were denied.
- [ ] Secret fingerprints differ across environments.
- [ ] Production contains no seed variables or demo business documents.
- [ ] Staging wildcard QA passed before the production wildcard moved.
