// Voice input via the Web Speech API (SpeechRecognition). Decoupled from any textarea: the hook
// only recognises speech and emits the running transcript (final-so-far + current interim) to the
// caller, which decides where to insert it (we append at the caret). If the API is unavailable the
// hook reports `supported: false` so the mic can be disabled with a tooltip rather than throwing.

import { useCallback, useEffect, useRef, useState } from "react";

interface SpeechRecognitionResultLike {
  0: { transcript: string };
  isFinal: boolean;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [i: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}
type SRCtor = new () => SpeechRecognitionLike;

function getSRCtor(): SRCtor | null {
  const w = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface VoiceInput {
  supported: boolean;
  listening: boolean;
  toggle: () => void;
  stop: () => void;
}

export interface VoiceCallbacks {
  onStart?: () => void; // snapshot the insertion point here
  onTranscript: (text: string) => void; // running transcript to insert (final + interim)
  onStop?: () => void;
}

export function useVoiceInput(cb: VoiceCallbacks): VoiceInput {
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const cbRef = useRef(cb);
  cbRef.current = cb; // always call the latest callbacks (they close over fresh component state)

  const supported = getSRCtor() !== null;

  const stop = useCallback(() => {
    recRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Ctor = getSRCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    rec.onresult = (e) => {
      let transcript = "";
      for (let i = 0; i < e.results.length; i++) transcript += e.results[i]![0].transcript;
      cbRef.current.onTranscript(transcript);
    };
    rec.onend = () => {
      recRef.current = null;
      setListening(false);
      cbRef.current.onStop?.();
    };
    rec.onerror = () => rec.stop();
    recRef.current = rec;
    cbRef.current.onStart?.();
    setListening(true);
    rec.start();
  }, []);

  const toggle = useCallback(() => {
    if (recRef.current) stop();
    else start();
  }, [start, stop]);

  // Stop cleanly if the component unmounts mid-recording.
  useEffect(() => () => recRef.current?.stop(), []);

  return { supported, listening, toggle, stop };
}
