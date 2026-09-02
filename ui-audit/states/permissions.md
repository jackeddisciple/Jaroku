# States — permissions

## Two opposite rules, both deliberate, and where each applies

### Rule 1 — absent (the product default)

`Capable.tsx:1-18`. A control a role cannot use is **absent from the DOM**:

> a **disabled** control is an offer being refused, which invites a person to work out what would
> enable it and tells them the feature exists in their workspace when the answer is that it exists
> for somebody else; a control **hidden** with CSS is one devtools panel away from being clicked,
> and the click reaches the relay. **Absent is the only one of the three that is true.**

### Rule 2 — disabled with a stated reason (the Cockpit's override)

`cockpitCopy.ts:294-308`. The Cockpit deliberately overrides Rule 1 for its own verbs:

> the argument is about a console specifically — an operator who cannot see that Stop exists
> concludes **the product cannot stop a job**, which is a worse belief to leave somebody with than
> "you cannot do this here".

## ⚠ Only two of the five Cockpit verbs follow Rule 2

`REFUSAL` defines five strings. Usage across the entire client:

| String | Used at | Behaviour |
|---|---|---|
| `REFUSAL.cancel` | `WorkDetail.tsx:285` | **disabled with a reason** ✓ |
| `REFUSAL.retry` | `WorkDetail.tsx:286` | **disabled with a reason** ✓ |
| `REFUSAL.dispatch` | **nowhere** | — |
| `REFUSAL.reconnect` | **nowhere** | `<Capable cmd="reconnectAgent">` → **absent** ✗ |
| `REFUSAL.kill` | **nowhere** | `<Capable cmd="killAgent">` → **absent** ✗ |

Three of the five strings are dead copy, and the two verbs the override was most clearly written for
— the ones on a console that an operator must know exist — are the two that deny by absence.

## The third pattern — disabled with a reason, outside the Cockpit

The **Connections** panel does it, and does it well. Each connector's control is present, disabled,
and carries a padlocked line naming the missing thing:

> This deployment has no google OAuth app configured, so there is nothing to connect to yet.

So the product has all three behaviours in production: absent (`Capable`), disabled-with-reason
(`DisabledReason`, Connections), and **absent-without-explanation** (the Members tab, which simply
does not exist on a personal workspace).

## Roles

| Role | What it can do |
|---|---|
| Member | Build, run, edit and evaluate agents |
| Admin | …and connect keys, servers, repositories and deployments |
| Owner | …and membership, billing, and the workspace itself |

## Audit limitation

**Every seeded account is `owner`.** No denial state was observable at runtime. Everything above is
read from `capabilities.ts`, `useCapability.ts`, `Capable.tsx` and `cockpitCopy.ts`, and is marked
accordingly. `GET /v1/secrets` answering **403** without an elevation was observed in the desktop
log — the one permission refusal seen in this audit, and it is server-side.
