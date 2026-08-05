# PR 12.5A Appointment Self-Service UX Refinements

## Scope

This follow-up changes customer-facing presentation only. It does not change management tokens,
transactions, scheduling, hostname resolution, persistence, or tenant eligibility.

## Staging QA

- [ ] Reschedule an appointment and confirm the page announces both sentences: the appointment was
      successfully rescheduled and an updated confirmation with a new management link was emailed.
- [ ] Confirm the rotated management link in the new email remains usable.
- [ ] Confirm `America/New_York` is shown as `Eastern Time (ET)` on the management summary while
      appointment calculations remain unchanged.
- [ ] For a business with a public phone and email, confirm **Need help?** appears below the actions,
      the phone is readable and clickable, and the email opens a mail client.
- [ ] For a business without public phone or email, confirm the help section is omitted without an
      empty heading or excess spacing.
- [ ] Confirm confirmation and reschedule emails say customers may reply when a Reply-To address is
      configured and include only configured public contact values.
- [ ] Open an expired or replaced management link and confirm the unavailable page directs the
      customer to the most recent email or the business.
- [ ] Repeat the management-page checks at 320 CSS pixels and with keyboard-only navigation.
- [ ] Confirm focus moves to the page heading after loading and after changing management modes.
- [ ] Confirm the browser console has no unexpected errors and no management credential appears in
      the URL, browser storage, or visible error text.

## Rollback

Redeploy the previous frontend and worker images together. No database, API, or environment rollback
is required because this task adds no schema or configuration changes.
