// What a chat is called on screen.
//
// A CHAT WAITING FOR ITS TOPIC TITLE IS A NEW CHAT, NOT ITS OWN FIRST LINE. The server leaves a chat on
// the user's plan untitled while that plan names it — see `noteUserMessage` — so the stored title is
// the store's placeholder for a moment. On screen that reads as "New chat", and the topic title types
// in over it when it arrives.
//
//   npm run test:topic-title

/** The server's stored title for a chat nobody has named yet. Mirrors `UNTITLED` in server/src/threadStore.ts. */
export const UNTITLED = "Untitled thread";

/** What a chat without a name yet is called on screen. */
export const NEW_CHAT = "New chat";

/** A chat's title as it is shown. */
export function chatTitle(title: string): string {
  return title === UNTITLED || title.trim() === "" ? NEW_CHAT : title;
}
