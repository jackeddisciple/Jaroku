"""Suites for the reviewed connector templates.

A package INSIDE tool_templates rather than beside it, and that is deliberate. The generator
copies a connector by name — `entry["file"]`, one file at a time — so nothing in this directory
can reach a generated project, while a suite living here imports the template it is about with
an ordinary relative import rather than through a path fixture that would have to be kept
correct.

Every suite in here is a plain script with a local `check(name, ok)` and a trailing ALL CORRECT
line, run as `python -m tool_templates.tests.<name>`, exactly as the TypeScript suites are plain
`tsx` scripts. Same reason: what runs in CI is what somebody runs locally, spelled the same way.

NOTHING HERE TOUCHES A NETWORK OR A REAL SDK. The connector SDKs live in an optional extra that
the base install does not have, and a suite that needed them would be a suite that runs on the
machines least likely to be checking. Each one installs a fake into `sys.modules` before the
template's lazy import runs, which is also the only way to assert what a template SENDS rather
than merely that it did not crash.
"""
