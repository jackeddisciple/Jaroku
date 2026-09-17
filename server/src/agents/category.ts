// The one value the category column has that nobody typed.
//
// A FILE FOR ONE CONSTANT, AND THE ALTERNATIVE WAS WORSE. It used to live at the bottom of
// `avatarRoster.ts`, beside the 3D roster and the hash that picked from it, because both were
// written in the same pass. That file is gone — the characters with it — and the constant is not:
// four modules import it, `agents.category` defaults to it, and §7's sidebar rule is about it.
//
// IT IS NOT IN `faces.ts` EITHER, deliberately. A face is a picture and a name; a category is what
// an agent is FOR. Putting the neutral category beside the faces would be the third time this
// repository filed a category rule under whatever identity feature happened to be shipping.
//
// THERE IS NO LIST OF PRESETS HERE and there must not be. The twenty-five-plus presets are a
// vocabulary in the interface and a string in the database (I6) — `test:agent-category` reads this
// file and fails on a copy of them.

/**
 * The value a row gets when nobody has said which category an agent is in.
 *
 * §5.1: "For category, backfill a single neutral value such as Uncategorized: do not guess from the
 * agent's name, and do not leave it nullable to avoid the decision." Guessing is the tempting one —
 * an agent called `invoice_chaser` is obviously Billing — and it is wrong for the same reason every
 * inferred field is: it is right often enough to be trusted and wrong often enough to mislead, with
 * nothing on screen to say which.
 *
 * The SIDEBAR treats this value specially: §7 says a row whose category is `Uncategorized` shows the
 * name alone rather than the placeholder, because "· Uncategorized" after every name is a column of
 * noise saying nothing.
 */
export const UNCATEGORIZED = "Uncategorized";
