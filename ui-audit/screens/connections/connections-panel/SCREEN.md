# SCREEN — Connections

| | |
|---|---|
| **Screen ID** | `CON-01` |
| **Screen name** | Connections |
| **Route / path** | the `connections` right-panel tab |
| **Parent area** | Connections |
| **Purpose** | Accounts this workspace's agents may act on behalf of |
| **Primary user goal** | Let an agent reach my mailbox / calendar / Slack, and know exactly what it can do |

## Structure

A vertical list of connector cards. Each card carries **four** things, in this order:

1. **Name** + a plug glyph + a state word (`not connected`)
2. **A capability sentence**, prefixed by a shield glyph — what the connector *can* do, and then,
   after a middot, **what it explicitly cannot**
3. **A blocker line**, prefixed by a padlock — why connecting is unavailable right now
4. **The connect control**, disabled when the blocker applies

## The capability sentences, verbatim

This is the most carefully-written copy in the product, and a redesign should keep the *shape*:

| Connector | Can · Cannot |
|---|---|
| **Gmail** | Read the messages in your mailbox, so an agent can search it · Create draft replies in your mailbox · **It cannot send mail, delete anything, or change your settings** |
| **Google Calendar** | See the events on your calendars, so an agent can answer questions about your week · Create and change events, which sends invitations to the people on them · **It cannot delete an event, and it cannot create, delete or share a calendar** |
| **Slack** | See the public channels in your Slack workspace, and read their recent messages · Post messages as the Jaroku app · **Posting is immediate and cannot be undone — point an agent at a test channel first** |
| **Stripe (Read-Only)** | Look up customers, payments, invoices and balances. **Read-only: no charges, refunds, or mutations of any kind.** Use a Stripe RESTRICTED key with read permissions only. |
| **Postgres** | Read-only SQL access. **Writes and DDL are rejected by both a statement check and a read-only transaction.** |

Two of them state a **consequence** rather than a permission — Slack's "posting is immediate and
cannot be undone" and Calendar's "which sends invitations to the people on them". Those are the two
connectors that touch other people.

## Two kinds of connector, two kinds of control

| Kind | Connectors | Control |
|---|---|---|
| **OAuth** | Gmail, Google Calendar, Slack | a `Connect <name>` button, disabled with a reason |
| **Credential** | Stripe, Postgres | a named field (`STRIPE_SECRET_KEY`, `DATABASE_URL`) + `Save`, with format guidance below |

Stripe's guidance is a refusal as well as a hint: *"`rk_live_…` — create one under Developers →
API keys → Restricted keys with READ permissions only. **A full-access `sk_live_` key is refused.**"*

## Denial behaviour — deny with a stated reason

The blocker line reads:

> This deployment has no google OAuth app configured, so there is nothing to connect to yet.

The control is present and disabled, and the reason names the missing thing. This is the
**disabled-with-a-reason** pattern, and it is the opposite of `Capable`'s absent-control default —
see [`../../../states/permissions.md`](../../../states/permissions.md).

Note the sentence uses the lowercase provider id (`google`, `slack`) rather than a display name.

## State list

| State | Screenshot | Notes |
|---|---|---|
| none connected, no OAuth app | `default.png` | Observed |
| connecting | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `server/src/oauth/` |
| connected | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `connectionStore.ts` |
| authentication required / expired credential | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `server/src/connectorAuth.test.ts`, `connectorSecrets.ts` |
| permission approval | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `server/src/permissionShield.ts` |
| failed connection | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `server/src/connectorLoop.test.ts` |

## Implementation references

`ConnectionsPanel.tsx` (25 KB) · `store/connectionStore.ts` · `lib/connectorDeck.ts` ·
`credentialGate.test.ts` · channel `connections` · `server/src/connectors.ts`,
`connectorSecrets.ts`, `conversationConnectors.ts`, `oauth/` · `runtime/tool_templates/`
