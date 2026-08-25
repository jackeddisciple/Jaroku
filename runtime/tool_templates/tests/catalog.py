"""The catalog's own two verifications, run by something other than a person remembering.

`check_catalog()` and `check_failures_raise()` have been in `tool_templates/__init__.py` since
the connectors were written. The README says to run the first "when adding a connector", ADR-014
says the same, and CONTRIBUTING says a connector without an `auth` mode is refused by it — three
documents describing a check that no workflow, no script and no npm target has ever invoked. So
the checks existed, passed on the machine of whoever last typed them into a REPL, and the four
kinds of drift they exist to catch could each have merged unnoticed:

  A CATALOG ENTRY WHOSE FILE IS NOT THERE. The generator copies `entry["file"]` verbatim into a
  project; a rename that updated the module and not the catalog produces a generation that fails
  on a missing path, at build time, for a user.

  A `required_env` THAT DISAGREES WITH ITS MODULE. That list is what `.env.example` is built from
  and what the connections panel offers, so a name in one place and not the other is an agent
  that reports itself configured and cannot authenticate — the same shape of failure as a key
  stored under a name the runtime does not read.

  A `pip_requires` OUTSIDE THE `connectors` EXTRA. A deployed image installs from that field. A
  typo there is not a lint failure: it is a container that builds and then raises ImportError on
  the first tool call, in production, against somebody's real account.

  A TOOL THAT RETURNS ITS OWN ERROR TEXT INSTEAD OF RAISING. This is the defect the whole
  raise-don't-return discipline exists for — LangChain records a returned string as a SUCCESSFUL
  tool call, so the trace draws a green step whose content happens to be an error and the model
  answers the user out of it. `check_failures_raise()` strips every configuring variable and
  proves every tool in every template still raises.

RUNS WITH THE BASE INSTALL AND NO NETWORK. Neither check needs a connector SDK: the templates
lazy-import theirs, so an absent SDK is itself one of the ways a tool is expected to raise.

  npm run test:connector-catalog
"""

from __future__ import annotations

import sys

from .. import CONNECTORS, check_catalog, check_failures_raise

failures = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failures
    if ok:
        print(f"  ok   {name}")
    else:
        failures += 1
        print(f"  FAIL {name}{f' — {detail}' if detail else ''}")


print("\nthe catalog still describes the modules it indexes")
problems = check_catalog()
check("check_catalog() reports no problems", not problems, "; ".join(problems))
check(f"and it had something to check ({len(CONNECTORS)} connectors)", len(CONNECTORS) > 0)

print("\nand every template tool raises rather than returning its reason as an answer")
unraised = check_failures_raise()
check("check_failures_raise() reports no problems", not unraised, "; ".join(unraised))

print("\nALL CORRECT" if failures == 0 else f"\n{failures} FAILURES")
sys.exit(0 if failures == 0 else 1)
