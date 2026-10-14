/**
 * agint-voice-hotkey: BROWSER half (push-to-talk auto-send, plan step 3a).
 *
 * Transport: the OS-level hotkey lives in a standalone loopback SSE daemon
 * (`bin/voice-hotkey.mjs`, Ctrl+Alt+Space hold). This half opens
 * `http://127.0.0.1:19400/events`; `down` starts a microphone capture,
 * `up` stops it, transcribes via the existing `ctx.remote.speech` namespace
 * (mounted by the official ui-voice-input bundle) and auto-submits through
 * `inputActions.submit()` — the very same SubmitMachine the Enter key drives.
 *
 * The capture chain (Recording / encodeWave / audioBase64) is ported verbatim
 * from `@deepseek-ai/dsh-experimental-client-ui-voice-input lib/client.js`
 * (4619-4772, 0.2.0-rc.2) minus the analyser (no waveform here).
 *
 * Seat: `conversation.input.left` (kind list, scope session) — a status chip,
 * invisible while idle and connected. It receives `sessionId` and
 * `inputActions` from the shell's session-scoped standard props.
 *
 * Claims: a module-level `activeRun` serializes dictation across simultaneous
 * mounts (split views). First press wins; other instances ignore events until
 * the run releases. Escape cancels; there is NO blur/hidden cancel on purpose:
 * background-window dictation is the whole point.
 */
window.__ModuleLoader__.load({
  id: 'agint-voice-hotkey',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const DAEMON_URL = 'http://127.0.0.1:19400/events';
    const FEEDBACK_MS = 4000;
    const USABLE_PHASES = new Set(['ready', 'standby', 'waking']);

    /** Module-level claim: at most one dictation run across all mounts. */
    let activeRun = null;

    class RecordingError extends Error {
      constructor(kind) {
        super(kind);
        this.kind = kind;
        this.name = 'RecordingError';
      }
    }

    /** Ported verbatim: canonical PCM16 16 kHz mono WAV for the Host face. */
    function encodeWave(samples) {
      const bytes = new Uint8Array(44 + samples.length * 2);
      const view = new DataView(bytes.buffer);
      const text = (at, value) => {
        for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i);
      };
      text(0, 'RIFF');
      view.setUint32(4, bytes.length - 8, true);
      text(8, 'WAVE');
      text(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, 16e3, true);
      view.setUint32(28, 32e3, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      text(36, 'data');
      view.setUint32(40, samples.length * 2, true);
      for (const [i, sample] of samples.entries()) {
        const value = Math.max(-1, Math.min(1, sample));
        view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
      }
      return bytes;
    }

    /** Ported verbatim: base64 for the JSON Remote carrier. */
    function audioBase64(bytes) {
      let text = '';
      for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return btoa(text);
    }

    /** Ported from the official Recording class (analyser stripped). */
    class Recording {
      stream;
      recorder;
      context;
      chunks = [];
      lifetime = new AbortController();
      disposal;

      async start(onError) {
        const devices = navigator.mediaDevices;
        if (!devices || typeof MediaRecorder === 'undefined') throw new RecordingError('unavailable');
        let stream;
        try {
          stream = await devices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
            video: false,
          });
        } catch (error) {
          if (error instanceof DOMException && error.name === 'NotAllowedError') throw new RecordingError('permission');
          throw error;
        }
        if (this.lifetime.signal.aborted) {
          stream.getTracks().forEach((track) => track.stop());
          throw new RecordingError('cancelled');
        }
        this.stream = stream;
        try {
          this.context = new AudioContext();
          this.recorder = new MediaRecorder(stream);
          this.recorder.ondataavailable = (event) => {
            if (!this.lifetime.signal.aborted && event.data.size > 0) this.chunks.push(event.data);
          };
          this.recorder.onerror = () => {
            if (this.lifetime.signal.aborted) return;
            this.dispose().catch(() => void 0);
            try {
              onError?.(new RecordingError('interrupted'));
            } catch (error) {
              console.error('[agint-voice-hotkey] recording error handler failed', error);
            }
          };
          this.recorder.start();
        } catch (error) {
          await this.dispose();
          throw error;
        }
      }

      async stop(maxDurationSeconds) {
        const recorder = this.recorder;
        const context = this.context;
        if (!recorder || !context || recorder.state !== 'recording') {
          await this.dispose();
          throw new RecordingError('empty');
        }
        try {
          await new Promise((resolve, reject) => {
            recorder.onstop = () => resolve();
            recorder.onerror = () => reject(new RecordingError('empty'));
            recorder.stop();
          });
          this.stream?.getTracks().forEach((track) => track.stop());
          this.lifetime.signal.throwIfAborted();
          const blob = new Blob(this.chunks, { type: recorder.mimeType });
          if (blob.size === 0) throw new RecordingError('empty');
          const decoded = await context.decodeAudioData(await blob.arrayBuffer());
          this.lifetime.signal.throwIfAborted();
          const offline = new OfflineAudioContext(1, Math.max(1, Math.floor(Math.min(decoded.duration, maxDurationSeconds) * 16e3)), 16e3);
          const source = offline.createBufferSource();
          source.buffer = decoded;
          source.connect(offline.destination);
          source.start();
          const resampled = await offline.startRendering();
          this.lifetime.signal.throwIfAborted();
          return encodeWave(resampled.getChannelData(0));
        } finally {
          await this.dispose();
        }
      }

      dispose() {
        if (!this.disposal) {
          const closing = Promise.withResolvers();
          this.disposal = closing.promise;
          this.release().then(closing.resolve, closing.reject);
        }
        return this.disposal;
      }

      async release() {
        this.lifetime.abort(new RecordingError('cancelled'));
        if (this.recorder?.state === 'recording') this.recorder.stop();
        this.stream?.getTracks().forEach((track) => track.stop());
        this.stream = void 0;
        const context = this.context;
        this.context = void 0;
        if (context) await context.close();
      }
    }

    const ERROR_TEXT = {
      empty: '录音太短，已丢弃',
      permission: '麦克风权限被拒绝',
      unavailable: '浏览器不支持录音',
      interrupted: '录音中断',
      cancelled: '已取消',
    };

    function failureText(failure) {
      if (failure instanceof RecordingError) return ERROR_TEXT[failure.kind] ?? `录音失败（${failure.kind}）`;
      return `失败：${failure instanceof Error ? failure.message : String(failure)}`;
    }

    function VoiceHotkey({ sessionId, inputActions, getSpeech }) {
      const [phase, setPhase] = React.useState('idle');
      const [message, setMessage] = React.useState('');
      const [pending, setPending] = React.useState('');
      const [connected, setConnected] = React.useState(false);
      const [seconds, setSeconds] = React.useState(0);
      const current = React.useRef(null);
      const feedbackTimer = React.useRef(0);

      const stopFeedbackTimer = () => {
        if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
        feedbackTimer.current = 0;
      };

      const feedback = React.useCallback((text) => {
        setMessage(text);
        setPhase('feedback');
        stopFeedbackTimer();
        feedbackTimer.current = setTimeout(() => {
          setPhase((p) => (p === 'feedback' ? 'idle' : p));
          setMessage('');
        }, FEEDBACK_MS);
      }, []);

      const cancelRun = React.useCallback(() => {
        const run = current.current;
        current.current = null;
        if (run) {
          clearTimeout(run.timer);
          run.abort.abort();
          run.capture.dispose().catch(() => void 0);
        }
        if (activeRun && activeRun.sessionId === sessionId) activeRun = null;
        setPending('');
        setMessage('');
        stopFeedbackTimer();
        setPhase('idle');
      }, [sessionId]);

      const finish = React.useCallback(async () => {
        const run = current.current;
        if (!run) return;
        if (run.phase === 'requesting') {
          run.upPending = true;
          return;
        }
        if (run.phase !== 'recording') return;
        run.phase = 'transcribing';
        current.current = null;
        clearTimeout(run.timer);
        setPhase('transcribing');
        try {
          const audio = await run.capture.stop(run.maxDurationSeconds);
          if (audio.byteLength > run.maxAudioBytes) {
            feedback(`录音超过 ${Math.round(run.maxAudioBytes / 1024 / 1024)} MB 上限，已丢弃`);
            return;
          }
          const speech = getSpeech();
          if (!speech) {
            feedback('语音服务不可用（ui-voice-input 未启用？）');
            return;
          }
          const result = await speech.transcribe({ audioBase64: audioBase64(audio), ...run.selection }, run.abort.signal);
          if (!result.ok) {
            feedback(`转写失败：${result.error.message}`);
            return;
          }
          if (result.value.text === '') {
            feedback('没听清（空结果）');
            return;
          }
          if (!inputActions.insertText(result.value.text, run.span)) {
            setPending(result.value.text);
            feedback('草稿变了，点「插入」补插');
            return;
          }
          inputActions.submit();
          setPhase('idle');
        } catch (failure) {
          feedback(failureText(failure));
        } finally {
          if (activeRun && activeRun.claim === run.claim) activeRun = null;
        }
      }, [feedback, getSpeech, inputActions]);

      const start = React.useCallback(async () => {
        if (!inputActions) return;
        const claim = Symbol('voice-run');
        activeRun = { claim, sessionId };
        setPhase('requesting');
        setMessage('');
        setPending('');
        try {
          const speech = getSpeech();
          if (!speech) throw new Error('speech 命名空间未就绪（ui-voice-input 未启用？）');
          const catalog = await speech.catalog();
          if (!catalog.ok) throw catalog.error;
          const value = catalog.value;
          const provider = value.providers.find((item) => item.id === value.selection.providerId);
          if (!USABLE_PHASES.has(provider?.preparation.phase)) {
            throw new Error(`识别模型未就绪（${provider?.preparation.phase ?? value.selection.providerId}）`);
          }
          const capture = new Recording();
          const run = {
            capture,
            claim,
            abort: new AbortController(),
            span: inputActions.captureInsertion(),
            selection: value.selection,
            maxDurationSeconds: value.maxDurationSeconds,
            maxAudioBytes: value.maxAudioBytes,
            startedAt: Date.now(),
            upPending: false,
            timer: 0,
            phase: 'requesting',
          };
          current.current = run;
          await capture.start((interrupted) => {
            if (current.current !== run) return;
            current.current = null;
            if (activeRun?.claim === claim) activeRun = null;
            run.abort.abort();
            feedback(failureText(interrupted));
          });
          if (current.current !== run || activeRun?.claim !== claim) {
            if (current.current === run) current.current = null;
            if (activeRun?.claim === claim) activeRun = null;
            await capture.dispose().catch(() => void 0);
            return;
          }
          run.phase = 'recording';
          setSeconds(0);
          setPhase('recording');
          if (run.upPending) {
            finish();
            return;
          }
          run.timer = setTimeout(() => finish(), run.maxDurationSeconds * 1e3);
        } catch (failure) {
          if (current.current?.claim === claim) current.current = null;
          if (activeRun?.claim === claim) activeRun = null;
          feedback(failureText(failure));
        }
      }, [feedback, finish, getSpeech, inputActions, sessionId]);

      /** SSE + Escape + session-switch teardown. */
      React.useEffect(() => {
        let source;
        try {
          source = new EventSource(DAEMON_URL);
        } catch {
          feedback('无法连接热键守护进程');
          return void 0;
        }
        source.onopen = () => setConnected(true);
        source.onerror = () => setConnected(false);
        source.onmessage = (event) => {
          let payload;
          try {
            payload = JSON.parse(event.data);
          } catch {
            return;
          }
          if (payload.type === 'hello') {
            setConnected(true);
            return;
          }
          if (payload.type === 'down') {
            if (!activeRun) start();
            return;
          }
          if (payload.type === 'up') {
            if (activeRun && activeRun.sessionId === sessionId) finish();
            return;
          }
        };
        const escape = (event) => {
          if (event.key === 'Escape' && (current.current || activeRun)) {
            event.preventDefault();
            cancelRun();
          }
        };
        document.addEventListener('keydown', escape);
        return () => {
          source.close();
          document.removeEventListener('keydown', escape);
          if (current.current || (activeRun && activeRun.sessionId === sessionId)) cancelRun();
        };
        // start/finish capture inputActions by identity; session switch rebuilds the pipe.
      }, [sessionId, start, finish, cancelRun, feedback]);

      /** Live timer display while recording. */
      React.useEffect(() => {
        if (phase !== 'recording') return void 0;
        const tick = setInterval(() => {
          const run = current.current;
          if (run) setSeconds(Math.floor((Date.now() - (run.startedAt ?? Date.now())) / 1000));
        }, 1000);
        return () => clearInterval(tick);
      }, [phase]);

      React.useEffect(() => stopFeedbackTimer, []);

      const insertPending = () => {
        if (!inputActions || !pending) return;
        if (inputActions.insertText(pending, inputActions.captureInsertion())) {
          inputActions.submit();
          setPending('');
          setMessage('');
          setPhase('idle');
        } else {
          feedback('仍无法插入，文本在剪贴板提示中保留');
        }
      };

      if (phase === 'idle') {
        if (connected) return null;
        return h('span', {
          title: `热键守护进程未连接：${DAEMON_URL}（先运行 node <本机部署位>/bin/voice-hotkey.mjs）`,
          style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #999)' },
        }, '热键离线');
      }
      const chipStyle = {
        fontSize: 12,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        color: 'var(--dsw-alias-label-primary, #333)',
      };
      const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      if (phase === 'recording') {
        return h('span', { style: chipStyle, 'aria-label': '正在录音' },
          h('span', { style: { color: 'var(--dsw-alias-state-error, #e5484d)' } }, '●'),
          `录音 ${mmss}`,
          h('span', { style: { color: 'var(--dsw-alias-label-tertiary, #999)' } }, '松开发送 · Esc 取消'));
      }
      if (phase === 'transcribing') {
        return h('span', { style: chipStyle }, '转写…');
      }
      if (phase === 'requesting') {
        return h('span', { style: chipStyle }, '启动麦克风…');
      }
      return h('span', { style: chipStyle, role: 'status' },
        message,
        pending ? h('button', {
          type: 'button',
          onClick: insertPending,
          style: { fontSize: 12, cursor: 'pointer' },
        }, '插入') : null,
        pending ? h('button', {
          type: 'button',
          onClick: () => { setPending(''); setMessage(''); setPhase('idle'); },
          style: { fontSize: 12, cursor: 'pointer' },
        }, '×') : null);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots;
        if (!slots || typeof slots.inject !== 'function') return;
        const getSpeech = () => {
          try {
            return ctx.remote?.speech;
          } catch {
            return void 0;
          }
        };
        const seat = 'conversation.input.left';
        let dispose;
        try {
          dispose = slots.inject(seat, () => slots.register({
            name: seat,
            inject: () => ({ getSpeech }),
          }, VoiceHotkey));
        } catch (err) {
          console.error('[agint-voice-hotkey] seat registration failed:', seat, err);
          return;
        }
        ctx.effect(() => {
          if (typeof dispose === 'function') dispose();
        }, 'agint-voice-hotkey: seat');
      },
    };
  },
});
