# Triage labels

The engineering skills use five canonical triage roles. This table maps each
role to the label used in the GitHub issue tracker.

Every open issue has exactly one canonical role. New reports start at
`needs-triage`; each transition removes the previous canonical role before
adding the next. Type and topic labels are preserved.

| Skill role        | Tracker label     | Meaning                                 |
| ----------------- | ----------------- | --------------------------------------- |
| `needs-triage`    | `needs-triage`    | Maintainer needs to evaluate the issue  |
| `needs-info`      | `needs-info`      | Waiting on the reporter for information |
| `ready-for-agent` | `ready-for-agent` | Fully specified and ready for an agent  |
| `ready-for-human` | `ready-for-human` | Requires human implementation           |
| `wontfix`         | `wontfix`         | Will not be actioned                    |

When a skill names a canonical role, apply the corresponding tracker label.
Edit the tracker-label column if the repository vocabulary changes.
