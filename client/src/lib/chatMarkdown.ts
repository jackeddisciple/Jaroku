// A conversation as Markdown, for Share Chat.
//
// WHAT IS COPIED IS WHAT WAS SAID. The user's words and Jaroku's replies go in as their Markdown
// source, the way `CopyTurn` copies one reply, so code fences survive the paste. A plan goes in as
// the plan text it streamed; a generation or a proposed change is named with what it touched, not
// reproduced, because the files themselves live in the agent rather than in the conversation.
//
//   npm run test:chat-markdown

import type { ChatTurn } from "../store/chatStore.ts";

/** The conversation's name as a heading: one line, whatever it was given. */
function heading(title: string): string {
  const line = title.replace(/\s+/g, " ").trim();
  return `# ${line || "Chat"}`;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One turn as a block of Markdown, or null for a turn with nothing to say. */
function turnMarkdown(turn: ChatTurn): string | null {
  if (turn.role === "user") {
    const text = turn.text.trim();
    return text ? `**You**\n\n${text}` : null;
  }
  switch (turn.kind) {
    case "reply": {
      const text = turn.text.trim();
      return text ? `**Jaroku**\n\n${text}` : null;
    }
    case "info": {
      const text = turn.text.trim();
      return text ? `> ${text.replace(/\n/g, "\n> ")}` : null;
    }
    case "plan": {
      const text = turn.raw.trim();
      return text ? `**Jaroku — plan**\n\n${text}` : null;
    }
    case "gen": {
      if (turn.files.length === 0) return "**Jaroku** generated the agent.";
      return `**Jaroku** generated ${plural(turn.files.length, "file")}:\n\n${turn.files.map((f) => `- \`${f}\``).join("\n")}`;
    }
    case "proposal": {
      const summary = turn.summary?.trim();
      const touched = plural(turn.files.length, "file");
      return summary ? `**Jaroku — proposed change** (${touched})\n\n${summary}` : `**Jaroku — proposed change** (${touched})`;
    }
    case "work": {
      const input = turn.input?.trim();
      return input ? `**Job sent to the agent**\n\n${input}` : "**Job sent to the agent**";
    }
  }
}

/** The whole conversation, titled, as one Markdown document. */
export function chatMarkdown(title: string, turns: readonly ChatTurn[]): string {
  const blocks = [heading(title)];
  for (const turn of turns) {
    const block = turnMarkdown(turn);
    if (block) blocks.push(block);
  }
  return `${blocks.join("\n\n")}\n`;
}
