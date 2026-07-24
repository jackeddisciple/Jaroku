// Voice input via the Web Speech API (SpeechRecognition), plus a live audio-level tap for the
// waveform visualiser. The hook only recognises speech + exposes an AnalyserNode; the caller
// decides where the transcript goes (we append at the caret) and how the waveform is drawn.
//
// Web Speech doesn't expose its own mic stream, so the analyser is fed from a short-lived
// getUserMedia() stream. Mic permission is per-origin (granted once), so this adds no second
// prompt — and the extra stream + AudioContext are torn down the moment recording stops. If
// AudioContext/getUserMedia are unavailable, `hasAnalyser` stays false and the UI falls back to
// the plain recording state (mic pulse only), rather than breaking.

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

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

function getAudioCtxCtor(): (typeof AudioContext) | null {
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export interface VoiceInput {
  supported: boolean;
  listening: boolean;
  toggle: () => void;
  stop: () => void;
  /** Live analyser for the waveform (null when not recording or Web Audio is unavailable). */
  analyserRef: MutableRefObject<AnalyserNode | null>;
  /** True while a live audio analyser is available — gates showing the waveform vs a plain pulse. */
  hasAnalyser: boolean;
}

export interface VoiceCallbacks {
  onStart?: () => void; // snapshot the insertion point here
  onTranscript: (text: string) => void; // running transcript to insert (final + interim)
  onStop?: () => void;
}

export function useVoiceInput(cb: VoiceCallbacks): VoiceInput {
  const [listening, setListening] = useState(false);
  const [hasAnalyser, setHasAnalyser] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const cbRef = useRef(cb);
  cbRef.current = cb; // always call the latest callbacks (they close over fresh component state)

  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const supported = getSRCtor() !== null;

  const teardownAudio = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioCtxRef.current?.close().catch(() => {});
    streamRef.current = null;
    audioCtxRef.current = null;
    analyserRef.current = null;
    setHasAnalyser(false);
  }, []);

  // Best-effort: open a mic stream + AnalyserNode for the live waveform. Never throws upward.
  const setupAnalyser = useCallback(async () => {
    const Ctor = getAudioCtxCtor();
    if (!Ctor || !navigator.mediaDevices?.getUserMedia) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!recRef.current) {
        // recording already stopped while we were awaiting permission — don't leave a live stream.
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const ctx = new Ctor();
      await ctx.resume().catch(() => {});
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.75;
      ctx.createMediaStreamSource(stream).connect(analyser);
      streamRef.current = stream;
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      setHasAnalyser(true);
    } catch {
      teardownAudio(); // graceful: no waveform, just the recording pulse
    }
  }, [teardownAudio]);

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
      teardownAudio();
      cbRef.current.onStop?.();
    };
    rec.onerror = () => rec.stop();
    recRef.current = rec;
    cbRef.current.onStart?.();
    setListening(true);
    rec.start();
    void setupAnalyser();
  }, [setupAnalyser, teardownAudio]);

  const toggle = useCallback(() => {
    if (recRef.current) stop();
    else start();
  }, [start, stop]);

  // Stop cleanly if the component unmounts mid-recording.
  useEffect(
    () => () => {
      recRef.current?.stop();
      teardownAudio();
    },
    [teardownAudio],
  );

  return { supported, listening, toggle, stop, analyserRef, hasAnalyser };
}
