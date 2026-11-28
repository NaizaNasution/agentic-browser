# What a Space keeps, and what clearing it affects

Each agent Space has a storage mode. This version supports **isolated** only.

| Mode | Starts with | Kept after `agb space close` | Affects the user's browser |
|---|---|---|---|
| `isolated` (this version) | Nothing: no cookies, no logins, empty storage | Nothing; cookies, storage, and cache are deleted | Never |
| `cloned` (later) | A copy of the user's logins for sites they allow | Nothing | Never: changes stay in the copy |
| `shared` (later) | The user's real session | Everything | Yes: signing out signs the user out |
| `persistent` (later) | Whatever this Space kept last time | Everything | Never |

In an isolated Space:

- Every site starts signed out. If a task needs a login, hand over to the user (see the guide's
  "Sign-in" rule); their sign-in lasts until the Space closes.
- Closing a tab keeps the Space's cookies; closing the Space deletes them.
- Downloads stay in the Space's download folder after the Space closes; the user can delete them.
