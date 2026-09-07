// The front door. One mark, the product's name, one line about it, one button.
//
// WHY A SCREEN BEFORE THE SIGN-IN SCREEN, when the sign-in screen already had a mark and a welcome
// on it. Because those two were doing different jobs in one place and the sign-in screen was
// winning: "Welcome to Jaroku" and a sentence about trustworthy agents sat directly above an email
// field, so the first thing a new user read was an introduction and the first thing a returning
// user read was also an introduction — every launch, forever, above the form they came for. Split
// in two, each screen gets to be about one thing. This one introduces the application. The one
// behind it asks for an address and says nothing else.
//
// IT IS A SMALLER WINDOW, and that is the part that cannot be done in CSS. A centred 340px column
// inside a 1440×900 frame does not read as a welcome screen, it reads as an application that has
// not finished loading — so the shell sizes the native window down to 560×620 for this screen and
// back up on the way out. `lib/windowStage.ts` is this side of that, `window.rs` is the other.
//
// AND IT NAMES THE PLATFORM, which is the one thing here that is not a constant. `release.yml`
// builds this for macOS, Windows and Linux; `platformName` in lib/modKey.ts is the single place in
// this client that reads what it is running on, and this screen is why it now answers three ways
// instead of two.

import { BRAND } from "../../lib/tokens.ts";
import { JarokuGlyph } from "../../lib/icons.tsx";
import { platformName } from "../../lib/modKey.ts";
import { AuthNotice, LegalLine } from "./AuthShell.tsx";
import { PrimaryButton } from "./controls.tsx";
import { Reveal } from "../onboarding/Reveal.tsx";

/**
 * The welcome screen.
 *
 * ON `AuthNotice` RATHER THAN `AuthShell`, and the shell's own comment is the reason: the card is a
 * container for a QUESTION, and this screen asks nothing. It says what the application is and
 * offers one way forward, which is the shape `AuthNotice` exists for — the same full-bleed dot
 * field as every screen around it, and no bordered box drawn around a sentence.
 */
export function SplashScreen({ onStart }: { onStart: () => void }) {
  return (
    <AuthNotice>
      <Reveal>
        <span className="inline-flex text-ink">
          <JarokuGlyph size={BRAND.hero} />
        </span>
      </Reveal>

      <Reveal delay={60}>
        {/* THE PREPOSITION IS THE ONLY ITALIC, and it is the smallest possible amount of it. Both
            halves that carry meaning — the product and the machine it is running on — are set
            identically, so the eye reads "Jaroku … Mac" as one weight and one name. The slant falls
            on the word joining them, which is the one word that is neither. Slanting "for Mac"
            entire was tried first and read as a name with a badge stuck on it.

            `font-normal` because the display rung carries 600, and an italic at semibold is a
            second emphasis on a word whose whole job is to be the quiet one. */}
        <h1 className="mt-7 text-display tracking-[-0.005em] text-ink">
          Jaroku <em className="font-normal italic">for</em> {platformName()}
        </h1>
      </Reveal>

      <Reveal delay={120}>
        <p className="mx-auto mt-3 max-w-[34ch] text-body text-muted">
          Your native workbench for building trustworthy AI agents
        </p>
      </Reveal>

      {/* THE BUTTON IS THE FULL WIDTH OF THE COLUMN, which is what makes it read as the way forward
          rather than as one of several. There is nothing else on this screen to press, and a
          content-width button floating in the middle of a 560px window would be an invitation to
          look for the alternative it implies. */}
      <Reveal delay={180}>
        <div className="mt-10">
          <PrimaryButton onClick={onStart} autoFocus>
            Get started
          </PrimaryButton>
        </div>
      </Reveal>

      {/* §3.1 REQUIRES THIS BEFORE THE ACTION THAT CREATES AN ACCOUNT, and this screen is now the
          first step of that path — so the line moves here as well rather than only sitting on the
          sign-in screen behind it. It is the same component, so the two cannot drift. */}
      <Reveal delay={240}>
        <div className="mx-auto mt-8 max-w-[380px] text-caption leading-[1.6] text-muted">
          <LegalLine />
        </div>
      </Reveal>
    </AuthNotice>
  );
}
