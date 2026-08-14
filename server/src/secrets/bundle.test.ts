// Reading an export from 1Password, Vault or Doppler, and refusing what should not become a
// credential.
//
// THE ASSERTION WORTH HAVING is the detection-order one. A HashiCorp KV-v2 document is ALSO a
// perfectly valid flat `{"NAME": "value"}` object whose single key happens to be `data`. Read as
// flat, it imports one credential called `data` holding a JSON blob and silently drops every real
// one — a bulk import that reports success and moved nothing. So the nested shapes are checked
// first, and that ordering is asserted here rather than left as a comment.
//
// The rest is refusals: a bulk path that accepted a name or a value the single path refuses would
// be a way around the store's rules, and the failure would surface much later as a run receiving a
// credential that had been quietly mangled.
//
//   npm run test:secret-import

import { describe, parseSecretBundle, validateBundle } from "./bundle.ts";
import { maskFor, GENERIC_MASK } from "./mask.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const read = (text: string) => validateBundle(parseSecretBundle(text));
const names = (text: string) => read(text).accepted.map((s) => s.name);
const valueOf = (text: string, name: string) => read(text).accepted.find((s) => s.name === name)?.value;

console.log("\ndotenv");
{
  const text = `
# a comment
API_ONE=plain-value-here
export API_TWO="quoted-value"
API_THREE='single-quoted'
API_FOUR=value=with=equals

not a line at all
`;
  check(names(text).join(",") === "API_ONE,API_TWO,API_THREE,API_FOUR", "every NAME=value line is read", names(text).join(","));
  check(valueOf(text, "API_TWO") === "quoted-value", "double quotes are stripped");
  check(valueOf(text, "API_THREE") === "single-quoted", "and single quotes");
  // Split on the FIRST equals only: a base64 credential ends in them, and splitting on every one
  // would silently truncate exactly the values most likely to be real.
  check(valueOf(text, "API_FOUR") === "value=with=equals", "only the first equals separates name from value");
  check(read(text).rejected.some((r) => r.reason.includes("NAME=value")), "and a line that is not one is reported");
  check(!names(text).includes("# a comment"), "comments are skipped, not imported");
}

console.log("\nflat json");
{
  const text = `{"ALPHA":"one","BETA":"two","GAMMA":42}`;
  check(names(text).join(",") === "ALPHA,BETA", "string values are read", names(text).join(","));
  check(read(text).rejected.some((r) => r.name === "GAMMA"), "a number is somebody's config, not a credential");
  check(parseSecretBundle(text).format === "json", "and the format is reported as flat json");
}

console.log("\ndoppler");
{
  const text = `{"DB_URL":{"raw":"postgres://raw","computed":"postgres://computed"}}`;
  check(parseSecretBundle(text).format === "doppler", "Doppler's richer shape is recognised");
  // The computed value is the one a run would actually have received.
  check(valueOf(text, "DB_URL") === "postgres://computed", "and the COMPUTED value is taken, not the raw one");
}

console.log("\nvault kv v2, and why order matters");
{
  const text = `{"data":{"data":{"REAL_ONE":"value-one","REAL_TWO":"value-two"},"metadata":{"version":3}}}`;
  const parsed = parseSecretBundle(text);
  check(parsed.format === "vault", "a KV-v2 document is recognised as one");
  check(names(text).join(",") === "REAL_ONE,REAL_TWO", "and the credentials inside it are read", names(text).join(","));
  // THE FAILURE THIS ORDERING PREVENTS.
  check(!names(text).includes("data"), "rather than one credential called 'data' and nothing else");
  check(!names(text).includes("metadata"), "and the metadata block is not imported as a credential");
}

console.log("\nwhat is refused");
{
  const bundle = read(`
lower_case=refused
1LEADING_DIGIT=refused
OK_NAME=fine-value-here
EMPTY_ONE=
`);
  const rejectedNames = bundle.rejected.map((r) => r.name);
  check(rejectedNames.includes("lower_case"), "a lower-case name is refused");
  check(rejectedNames.includes("1LEADING_DIGIT"), "and one starting with a digit");
  check(rejectedNames.includes("EMPTY_ONE"), "and an empty value, which is a template placeholder");
  check(bundle.accepted.map((s) => s.name).join(",") === "OK_NAME", "leaving only what can actually be stored");
  // The same gate the single-credential path uses, so a bundle is not a back door around it.
  const newline = read(`BROKEN=first\\nsecond`);
  check(newline.accepted.length === 1, "an escaped newline is text, not a line break, and is fine");
}

console.log("\nduplicates and reporting");
{
  const bundle = read(`DUPE=first\nDUPE=second`);
  check(bundle.accepted.length === 1, "a repeated name appears once");
  check(bundle.accepted[0]?.value === "second", "and the later one wins, as a .env loader does");

  const described = describe(read(`SOME_KEY=a-real-credential-value\nbad=x`));
  check(described.imported.join(",") === "SOME_KEY", "describe() reports the names imported");
  check(
    !JSON.stringify(described).includes("a-real-credential-value"),
    "and carries no value at all, which is why the route answers with it",
  );
}

console.log("\nmasks");
{
  check(maskFor("sk-ant-api03-abcdefghijklmnop9c11") === "sk-ant-api03-...9c11", "a known prefix survives, with four characters");
  check(maskFor("ghp_abcdefghijklmnopqrstuvwxyz") === "ghp_...wxyz", "and so does a GitHub token's");
  check(maskFor("short") === GENERIC_MASK, "a short value shows nothing but dots");
  // The line the mask draws: four characters of an eight-character value is half the credential.
  check(maskFor("1234567890123456789") === GENERIC_MASK, "and so does anything under twenty characters");
  check(maskFor("").length > 0 && maskFor("") === GENERIC_MASK, "an empty value masks like anything else");
  const masked = maskFor("sk-ant-api03-MIDDLE-ENTROPY-HERE-9c11");
  check(!masked.includes("MIDDLE"), "nothing from the middle of a key ever appears in a mask");
  check(!masked.includes("ENTROPY"), "...which is where the entropy is");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
