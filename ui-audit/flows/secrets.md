# Flow — add a secret

| # | Step | Observed |
|---|---|---|
| 1 | Open the `secrets` tab | ✓ |
| 2 | **Set a passcode** — six to twelve characters, per person, not per workspace | ✓ |
| 3 | `Verify identity & save` | ✗ |
| 4 | The list appears | ✗ |
| 5 | Add a named credential | ✗ |
| 6 | Health and rotation age are shown | ✗ |

The gate states what it does **and what it does not do**: *"It protects this view — it does not
encrypt your secrets."*

Server-side, `GET /v1/secrets` answers **403** without an elevation — the one permission refusal
observed in this audit.
