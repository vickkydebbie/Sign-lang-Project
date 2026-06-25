'use client';

/**
 * app/page.tsx
 *
 * Main page: Speech + text input → NLP tokenization → 3D sign simulation.
 * Uses the native Web Speech API (no external service).
 */

import dynamic from 'next/dynamic';
import { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import { tokenize, loadDictionary, loadDictionaryKeys } from '@/lib/nlpUtils';

// Dynamically import the canvas so Three.js is never server-rendered
const SimulationCanvas = dynamic(
  () => import('@/components/SimulationCanvas'),
  { ssr: false }
);

// ---------------------------------------------------------------------------
// Type helpers (JSDoc-typed for plain JS compat)
// ---------------------------------------------------------------------------
/** @typedef {{ token: string, type: 'word'|'letter', source: string }} Token */

// ---------------------------------------------------------------------------
// Web Speech API singleton
// ---------------------------------------------------------------------------
let recognitionInstance = null;

function getRecognition() {
  if (typeof window === 'undefined') return null;
  if (recognitionInstance) return recognitionInstance;
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;
  const r = new SpeechRecognition();
  r.continuous      = false;
  r.interimResults  = true;
  r.lang            = 'en-US';
  recognitionInstance = r;
  return r;
}

// ---------------------------------------------------------------------------
// MicButton component
// ---------------------------------------------------------------------------
function MicButton({ isListening, disabled, onClick }) {
  return (
    <button
      id="mic-btn"
      onClick={onClick}
      disabled={disabled}
      aria-label={isListening ? 'Stop recording' : 'Start speaking'}
      className={[
        'relative flex items-center justify-center w-12 h-12 rounded-full',
        'transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-blue-400/60',
        isListening
          ? 'bg-red-500 hover:bg-red-600 shadow-lg shadow-red-500/40'
          : 'bg-blue-600 hover:bg-blue-500 shadow-lg shadow-blue-600/30',
        disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
      ].join(' ')}
    >
      {isListening && (
        <span className="animate-pulse-ring absolute inset-0 rounded-full bg-red-400 opacity-60" />
      )}
      {isListening ? (
        /* Stop icon */
        <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
      ) : (
        /* Microphone icon */
        <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12 1a4 4 0 0 1 4 4v6a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4zm0 2a2 2 0 0 0-2 2v6a2 2 0 0 0 4 0V5a2 2 0 0 0-2-2z"/>
          <path d="M7 11a1 1 0 0 1 1 1 4 4 0 0 0 8 0 1 1 0 1 1 2 0 6 6 0 0 1-5 5.91V20h2a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h2v-2.09A6 6 0 0 1 6 12a1 1 0 0 1 1-1z"/>
        </svg>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// TokenBadge
// ---------------------------------------------------------------------------
function TokenBadge({ token, isActive, index }) {
  return (
    <span
      style={{ animationDelay: `${index * 40}ms` }}
      className={[
        'token-badge inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold',
        'transition-all duration-300',
        token.type === 'word'
          ? isActive
            ? 'bg-blue-500 text-white ring-2 ring-blue-300 scale-110'
            : 'bg-blue-500/20 text-blue-300 ring-1 ring-blue-500/40'
          : isActive
            ? 'bg-violet-500 text-white ring-2 ring-violet-300 scale-110'
            : 'bg-violet-500/20 text-violet-300 ring-1 ring-violet-500/40',
      ].join(' ')}
    >
      {token.type === 'letter' && (
        <span className="opacity-60 font-mono text-[10px]">FS</span>
      )}
      {token.token}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------
export default function Page() {
  const [inputText,    setInputText]    = useState('');
  const [interimText,  setInterimText]  = useState('');
  const [tokens,       setTokens]       = useState(/** @type {Token[]} */ ([]));
  const [dictionary,   setDictionary]   = useState({});
  const [dictKeys,     setDictKeys]     = useState(new Set());
  const [isListening,  setIsListening]  = useState(false);
  const [isPlaying,    setIsPlaying]    = useState(false);
  const [activeIndex,  setActiveIndex]  = useState(0);
  const [speechSupported, setSpeechSupported] = useState(true);
  const [statusMsg,    setStatusMsg]    = useState('');
  const [signSpeed,    setSignSpeed]    = useState(1.0);
  const [cameraPreset, setCameraPreset] = useState<'front'|'side'|'angle'>('front');

  const recognitionRef = useRef(null);
  const inputRef       = useRef(null);

  // Load dictionary on mount
  useEffect(() => {
    Promise.all([loadDictionary(), loadDictionaryKeys()]).then(([dict, keys]) => {
      setDictionary(dict);
      setDictKeys(keys);
    });
  }, []);

  // Check speech support
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const supported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
      setSpeechSupported(supported);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Submit handler — tokenize text and start playback
  // ---------------------------------------------------------------------------
  const handleSubmit = useCallback(
    (text) => {
      const raw = (text || inputText).trim();
      if (!raw) return;

      const result = tokenize(raw, dictKeys);
      setTokens(result);
      setActiveIndex(0);
      setIsPlaying(result.length > 0);
      setStatusMsg(
        result.length === 0
          ? 'No ASL tokens found — try a different phrase.'
          : `Showing ${result.length} sign${result.length !== 1 ? 's' : ''}…`
      );
    },
    [inputText, dictKeys]
  );

  // ---------------------------------------------------------------------------
  // Web Speech API
  // ---------------------------------------------------------------------------
  const startListening = useCallback(() => {
    const recognition = getRecognition();
    if (!recognition) return;
    recognitionRef.current = recognition;

    setInterimText('');
    setStatusMsg('Listening…');

    recognition.onresult = (event) => {
      let interim = '';
      let finalStr = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalStr += transcript;
        } else {
          interim += transcript;
        }
      }
      setInterimText(interim);
      if (finalStr) {
        const combined = (inputText + ' ' + finalStr).trim();
        setInputText(combined);
        setInterimText('');
        setIsListening(false);
        handleSubmit(combined);
      }
    };

    recognition.onerror = (event) => {
      console.warn('SpeechRecognition error:', event.error);
      setIsListening(false);
      setInterimText('');
      setStatusMsg(
        event.error === 'not-allowed'
          ? 'Microphone access denied.'
          : `Speech error: ${event.error}`
      );
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognition.start();
    setIsListening(true);
  }, [handleSubmit, inputText]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setIsListening(false);
    setInterimText('');
  }, []);

  const toggleMic = useCallback(() => {
    if (isListening) stopListening();
    else startListening();
  }, [isListening, startListening, stopListening]);

  // ---------------------------------------------------------------------------
  // Token advance callback from canvas
  // ---------------------------------------------------------------------------
  const handleTokenAdvance = useCallback((index) => {
    if (index < 0) {
      setIsPlaying(false);
      setActiveIndex(0);
      setStatusMsg('Done — enter another phrase.');
    } else {
      setActiveIndex(index);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Replay
  // ---------------------------------------------------------------------------
  const handleReplay = useCallback(() => {
    if (tokens.length === 0) return;
    setActiveIndex(0);
    setIsPlaying(false);
    // Brief pause before re-triggering so the canvas resets
    setTimeout(() => setIsPlaying(true), 80);
    setStatusMsg(`Replaying ${tokens.length} sign${tokens.length !== 1 ? 's' : ''}…`);
  }, [tokens]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const displayText = interimText ? interimText : inputText;

  return (
    <main className="min-h-screen flex flex-col bg-gray-950">

      {/* ── Header ── */}
      <header className="flex-none px-6 pt-8 pb-4 text-center">
        <h1 className="text-3xl sm:text-4xl font-bold gradient-text mb-1">
          Sign Language Simulator
        </h1>
        <p className="text-gray-400 text-sm sm:text-base">
          Speech &amp; text-controlled 3D ASL hand simulation
        </p>
      </header>

      {/* ── Main layout ── */}
      <div className="flex-1 flex flex-col lg:flex-row gap-4 px-4 pb-6 max-w-7xl mx-auto w-full">

        {/* Left panel — canvas */}
        <section className="flex-1 min-h-[360px] lg:min-h-0 glass rounded-2xl overflow-hidden relative">
          <Suspense
            fallback={
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
              </div>
            }
          >
            <SimulationCanvas
              tokens={tokens}
              dictionary={dictionary}
              isPlaying={isPlaying}
              activeIndex={activeIndex}
              onTokenAdvance={handleTokenAdvance}
              signSpeed={signSpeed}
              cameraPreset={cameraPreset}
            />
          </Suspense>

          {/* Overlay: current sign label */}
          {isPlaying && tokens[activeIndex] && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 pointer-events-none">
              <div className="glass px-4 py-1.5 rounded-full text-sm font-bold text-white tracking-widest">
                {tokens[activeIndex].token}
                {tokens[activeIndex].type === 'letter' && (
                  <span className="ml-2 text-violet-300 text-xs font-normal">
                    fingerspell
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Idle prompt */}
          {!isPlaying && tokens.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none select-none">
              <div className="text-5xl mb-3 opacity-30">🤟</div>
              <p className="text-gray-500 text-sm text-center px-8">
                Type or speak a phrase to begin the simulation
              </p>
            </div>
          )}
        </section>

        {/* Right panel — controls */}
        <aside className="flex-none w-full lg:w-80 flex flex-col gap-4">

          {/* Input card */}
          <div className="glass rounded-2xl p-5 flex flex-col gap-3">
            <label htmlFor="text-input" className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
              Input Phrase
            </label>

            <div className="flex gap-2">
              <input
                ref={inputRef}
                id="text-input"
                type="text"
                value={interimText || inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSubmit(inputText)}
                placeholder={isListening ? 'Listening…' : 'Type your phrase here…'}
                className={[
                  'flex-1 bg-white/5 border rounded-xl px-3 py-2.5 text-sm text-white',
                  'placeholder-gray-500 outline-none transition-all',
                  isListening
                    ? 'border-red-500/60 ring-2 ring-red-500/20'
                    : 'border-white/10 focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20',
                ].join(' ')}
              />
              <MicButton
                isListening={isListening}
                disabled={!speechSupported}
                onClick={toggleMic}
              />
            </div>

            {!speechSupported && (
              <p className="text-xs text-amber-400">
                ⚠ Web Speech API not supported in this browser. Use Chrome or Edge.
              </p>
            )}

            <button
              id="simulate-btn"
              onClick={() => handleSubmit(inputText)}
              disabled={!inputText.trim() || isListening}
              className={[
                'w-full rounded-xl py-2.5 font-semibold text-sm transition-all duration-200',
                'bg-gradient-to-r from-blue-600 to-violet-600',
                'hover:from-blue-500 hover:to-violet-500 hover:shadow-lg hover:shadow-blue-500/20',
                'active:scale-95',
                (!inputText.trim() || isListening) ? 'opacity-40 cursor-not-allowed' : '',
              ].join(' ')}
            >
              Simulate →
            </button>
          </div>

          {/* Tokens card */}
          {tokens.length > 0 && (
            <div className="glass rounded-2xl p-5 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  ASL Tokens
                </span>
                <button
                  id="replay-btn"
                  onClick={handleReplay}
                  className="text-xs text-blue-400 hover:text-blue-300 transition-colors font-medium"
                >
                  ↻ Replay
                </button>
              </div>

              <div className="flex flex-wrap gap-2">
                {tokens.map((t, i) => (
                  <TokenBadge
                    key={`${t.token}-${i}`}
                    token={t}
                    index={i}
                    isActive={isPlaying && i === activeIndex}
                  />
                ))}
              </div>

              <div className="mt-1 flex gap-4 text-xs text-gray-500">
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-blue-500/60 inline-block" />
                  Word sign
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-violet-500/60 inline-block" />
                  Fingerspell
                </span>
              </div>
            </div>
          )}

          {/* Status card */}
          {statusMsg && (
            <div className="glass rounded-2xl px-4 py-3 text-xs text-gray-300 text-center">
              {statusMsg}
            </div>
          )}

          {/* Speed control card */}
          <div className="glass rounded-2xl p-5 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <label htmlFor="speed-slider" className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Sign Speed
              </label>
              <span className="text-xs font-mono text-blue-400">{signSpeed.toFixed(1)}×</span>
            </div>
            <input
              id="speed-slider"
              type="range"
              min={0.5}
              max={2.0}
              step={0.1}
              value={signSpeed}
              onChange={(e) => setSignSpeed(parseFloat(e.target.value))}
              className="w-full h-1.5 rounded-full appearance-none bg-white/10 accent-blue-500 cursor-pointer"
            />
            <div className="flex justify-between text-[10px] text-gray-600">
              <span>0.5× Slow</span><span>1× Normal</span><span>2× Fast</span>
            </div>
          </div>

          {/* Camera preset card */}
          <div className="glass rounded-2xl p-5 flex flex-col gap-3">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Camera View</p>
            <div className="flex gap-2">
              {(['front', 'side', 'angle'] as const).map((preset) => (
                <button
                  key={preset}
                  id={`cam-${preset}`}
                  onClick={() => setCameraPreset(preset)}
                  className={[
                    'flex-1 py-1.5 rounded-lg text-xs font-semibold capitalize transition-all duration-200',
                    cameraPreset === preset
                      ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30'
                      : 'bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white',
                  ].join(' ')}
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>

          {/* Info card */}
          <div className="glass rounded-2xl p-5 flex flex-col gap-2">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">
              How it works
            </p>
            <ul className="space-y-1.5 text-xs text-gray-400">
              <li>🎤 <strong className="text-gray-300">Speak</strong> — browser Web Speech API transcribes live</li>
              <li>⚙️ <strong className="text-gray-300">Clean</strong> — lemmatize + strip ASL stop words</li>
              <li>📚 <strong className="text-gray-300">Lookup</strong> — match tokens against dictionary</li>
              <li>✋ <strong className="text-gray-300">Spell</strong> — unknown words fingerspelled letter-by-letter</li>
              <li>🎬 <strong className="text-gray-300">LERP</strong> — smooth bone transitions via Three.js</li>
            </ul>
          </div>

        </aside>
      </div>
    </main>
  );
}
