// One transport belongs to one explicitly started conversation. Late callbacks
// from a cancelled permission prompt or socket cannot affect the next session.
export function createSession({
  onState,
  onCaption,
  onBoundary,
  onLevel,
  onActivity,
}) {
  let session;
  function state(phase, message) {
    onState({
      phase,
      message,
      mode: session?.mode,
      muted: session?.muted || false,
    });
  }
  function silence(s) {
    for (const source of s.playing) {
      source.onended = null;
      try {
        source.stop();
      } catch {}
    }
    s.playing.clear();
    s.playAt = 0;
    onLevel(0);
  }
  function end(message) {
    const s = session;
    session = undefined;
    if (s) {
      clearTimeout(s.timer);
      silence(s);
      s.stream?.getTracks().forEach((t) => t.stop());
      s.capture?.disconnect();
      s.input?.disconnect();
      s.audio?.close().catch(() => {});
      s.ws?.close();
      onBoundary();
      onActivity(message ? "Conversation interrupted" : "Conversation ended");
    }
    state(message ? "error" : "idle", message);
  }
  function play(s, event) {
    if (!s.audio) return;
    const raw = atob(event.data),
      length = Math.floor(raw.length / 2);
    if (!length) return;
    const rate = Number(/rate=(\d+)/.exec(event.mimeType)?.[1] || 24000);
    const buffer = s.audio.createBuffer(1, length, rate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      const value = raw.charCodeAt(2 * i) | (raw.charCodeAt(2 * i + 1) << 8);
      samples[i] = (value >= 32768 ? value - 65536 : value) / 32768;
    }
    if (s.playAt - s.audio.currentTime > 12)
      throw new Error("Playback fell behind. Reconnect to continue.");
    const output = s.audio.createBufferSource();
    output.buffer = buffer;
    output.connect(s.audio.destination);
    s.playing.add(output);
    s.playAt = Math.max(s.playAt, s.audio.currentTime + 0.025);
    output.onended = () => {
      s.playing.delete(output);
      if (session === s && !s.playing.size && s.turnDone) state("listening");
    };
    output.start(s.playAt);
    s.playAt += buffer.duration;
    state("speaking");
  }
  function submit(s, text) {
    silence(s);
    onBoundary();
    onCaption("You", text);
    onBoundary();
    s.turnDone = false;
    s.ws.send(JSON.stringify({ type: "text", text }));
    state("thinking");
  }
  async function start(mode, initialText) {
    if (session) return;
    const s = {
      mode,
      playing: new Set(),
      playAt: 0,
      ready: false,
      muted: false,
      turnDone: true,
    };
    session = s;
    try {
      if (mode === "voice") {
        state("requesting_permission");
        if (!navigator.mediaDevices?.getUserMedia)
          throw new Error(
            "Microphone access requires HTTPS and a supported browser. You can type below.",
          );
        s.audio = new AudioContext();
        await s.audio.resume();
        if (session !== s) return;
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            channelCount: 1,
          },
        });
        if (session !== s) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        s.stream = stream;
        stream.getAudioTracks()[0].onended = () => {
          if (session === s)
            end("Microphone disconnected. Reconnect it or type below.");
        };
        await s.audio.audioWorklet.addModule("/pcm-capture.js");
        if (session !== s) return;
        s.input = s.audio.createMediaStreamSource(stream);
        s.capture = new AudioWorkletNode(s.audio, "pcm-capture");
        s.input.connect(s.capture);
        s.capture.connect(s.audio.destination);
        s.capture.port.onmessage = ({ data }) => {
          if (
            session !== s ||
            !s.ready ||
            s.muted ||
            s.ws.readyState !== WebSocket.OPEN
          )
            return;
          if (s.ws.bufferedAmount < 131072) s.ws.send(data);
          let max = 0;
          for (const sample of new Int16Array(data))
            max = Math.max(max, Math.abs(sample));
          onLevel(max / 32768);
        };
      }
      state("connecting");
      const ws = new WebSocket(
        location.origin.replace(/^http/, "ws") + "/api/assistant/" + mode,
      );
      s.ws = ws;
      s.timer = setTimeout(() => {
        if (session === s) end("Connection timed out. Try again.");
      }, 25000);
      ws.onmessage = ({ data }) => {
        if (session !== s) return;
        try {
          const event = JSON.parse(data);
          switch (event.type) {
            case "ready":
              clearTimeout(s.timer);
              s.ready = true;
              onActivity(
                mode === "voice"
                  ? "Voice session connected"
                  : "Text session connected",
              );
              state(mode === "voice" ? "listening" : "text");
              if (initialText) submit(s, initialText);
              break;
            case "transcript":
              if (typeof event.delta === "string")
                onCaption(
                  event.speaker === "You" ? "You" : "Edith",
                  event.delta,
                );
              if (event.speaker === "You") {
                s.turnDone = false;
                state("thinking");
              }
              break;
            case "audio":
              s.turnDone = false;
              play(s, event);
              break;
            case "interrupted":
              silence(s);
              onBoundary();
              state("listening");
              break;
            case "turnComplete":
              s.turnDone = true;
              onBoundary();
              if (!s.playing.size)
                state(mode === "voice" ? "listening" : "text");
              break;
            case "working":
              state(event.active ? "executing" : "thinking");
              break;
            case "error":
              end(event.message);
              break;
            case "closed":
              end();
              break;
          }
        } catch {
          end(
            "The response could not be played. Reconnect or type another message.",
          );
        }
      };
      ws.onerror = () => {
        if (session === s) end("Could not connect to Edith. Try again.");
      };
      ws.onclose = () => {
        if (session === s)
          end("Connection ended. Start a new conversation to reconnect.");
      };
    } catch (error) {
      if (session === s)
        end(
          error.name === "NotAllowedError"
            ? "Microphone permission was denied. Allow it in site settings or type below."
            : error.name === "NotFoundError"
              ? "No microphone was found. You can type below."
              : error.message,
        );
    }
  }
  return {
    start,
    end,
    send(text) {
      if (!session) {
        start("text", text);
        return true;
      }
      if (!session.ready || session.ws.readyState !== WebSocket.OPEN)
        return false;
      submit(session, text);
      return true;
    },
    mute() {
      const s = session;
      if (!s?.stream || !s.ready) return;
      s.muted = !s.muted;
      s.stream.getAudioTracks().forEach((t) => (t.enabled = !s.muted));
      if (s.muted) {
        s.ws.send(JSON.stringify({ type: "mute" }));
        onLevel(0);
      }
      state(s.playing.size ? "speaking" : "listening");
    },
  };
}
