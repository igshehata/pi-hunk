// Startup protocol gate for full-screen takeover. Capability requests must reach
// the real terminal, but no child paint is published until a complete frame.

const FRAME_START = "\x1b[?2026h";
const FRAME_END = "\x1b[?2026l";
const EXIT_DETAIL_MAX_CHARS = 2000;
const EXIT_DETAIL_MAX_LINES = 12;
const EXIT_CAPTURE_MAX_CHARS = 16_000;
const ESCAPE_DISAMBIGUATION_MS = 10;

interface EscapeToken {
  end: number;
  complete: boolean;
}

function escapeToken(source: string, start: number): EscapeToken {
  if (source[start] !== "\x1b") return { end: start + 1, complete: true };
  if (start + 1 >= source.length) return { end: source.length, complete: false };
  const kind = source[start + 1];
  if (kind === "[") {
    for (let index = start + 2; index < source.length; index += 1) {
      const code = source.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return { end: index + 1, complete: true };
    }
    return { end: source.length, complete: false };
  }
  if (kind === "]") {
    for (let index = start + 2; index < source.length; index += 1) {
      if (source[index] === "\x07") return { end: index + 1, complete: true };
      if (source[index] === "\x1b" && source[index + 1] === "\\") {
        return { end: index + 2, complete: true };
      }
    }
    return { end: source.length, complete: false };
  }
  if (kind === "P" || kind === "_") {
    for (let index = start + 2; index < source.length; index += 1) {
      if (source[index] === "\x1b" && source[index + 1] === "\\") {
        return { end: index + 2, complete: true };
      }
    }
    return { end: source.length, complete: false };
  }
  if (kind === "O") {
    return start + 2 < source.length
      ? { end: start + 3, complete: true }
      : { end: source.length, complete: false };
  }
  return { end: start + 2, complete: true };
}

/** Queries known to be used by Hunk/OpenTUI 0.17.6 startup negotiation. */
function isCapabilityQuery(sequence: string): boolean {
  if (sequence.startsWith("\x1b[")) {
    const body = sequence.slice(2, -1);
    const final = sequence.at(-1);
    return (
      final === "n" ||
      final === "c" ||
      (final === "p" && body.endsWith("$")) ||
      (final === "q" && body === ">0") ||
      (final === "u" && body === "?") ||
      (final === "t" && /^(?:14|16|18)$/.test(body))
    );
  }
  if (sequence.startsWith("\x1b]")) {
    const terminatorLength = sequence.endsWith("\x1b\\") ? 2 : 1;
    const payload = sequence.slice(2, -terminatorLength);
    return sequence.includes("?") || payload === "1337;Capabilities";
  }
  if (sequence.startsWith("\x1bP")) return sequence.includes("+q");
  return false;
}

function stripCapabilityQueries(source: string): string {
  let output = "";
  let cursor = 0;
  while (cursor < source.length) {
    const escape = source.indexOf("\x1b", cursor);
    if (escape < 0) return output + source.slice(cursor);
    output += source.slice(cursor, escape);
    const token = escapeToken(source, escape);
    const sequence = source.slice(escape, token.end);
    if (!token.complete || !isCapabilityQuery(sequence)) output += sequence;
    cursor = token.end;
  }
  return output;
}

class CapabilityQueryForwarder {
  private pending = "";

  constructor(private readonly write: (sequence: string) => void) {}

  /** Forward complete queries and report whether complete non-query output was seen. */
  push(source: string): boolean {
    this.pending += source;
    let cursor = 0;
    let hasRendererOutput = false;
    while (cursor < this.pending.length) {
      const escape = this.pending.indexOf("\x1b", cursor);
      if (escape < 0) {
        hasRendererOutput ||= cursor < this.pending.length;
        this.pending = "";
        return hasRendererOutput;
      }
      hasRendererOutput ||= escape > cursor;
      const token = escapeToken(this.pending, escape);
      if (!token.complete) {
        this.pending = this.pending.slice(escape);
        return hasRendererOutput;
      }
      const sequence = this.pending.slice(escape, token.end);
      if (isCapabilityQuery(sequence)) this.write(sequence);
      else hasRendererOutput = true;
      cursor = token.end;
    }
    this.pending = "";
    return hasRendererOutput;
  }

  clear(): void {
    this.pending = "";
  }
}

export interface TakeoverStartupEvent {
  ready: boolean;
  frameStarted: boolean;
  fallbackEligible: boolean;
}

/**
 * Split the temporarily leased raw stdin stream into complete terminal events.
 * User keys pass through the exact listener installed on TakeoverHunk so prefix
 * chords retain Pi-side interception. Structured terminal replies bypass key
 * translation and remain byte-for-byte PTY input.
 */
export class TakeoverStartupInput {
  private pending = "";
  private decoder = new TextDecoder();
  private escapeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly dispatch: (data: string) => void,
    private readonly forwardReply: (data: string) => void = dispatch,
  ) {}

  push(data: string | Uint8Array): void {
    this.clearEscapeTimer();
    if (typeof data === "string") {
      const decoded = this.decoder.decode();
      this.decoder = new TextDecoder();
      this.process(decoded + data);
      return;
    }
    const decoded = this.decoder.decode(data, { stream: true });
    if (decoded) this.process(decoded);
  }

  /** Deliver a pending standalone Escape before the temporary raw-input lease ends. */
  flush(): void {
    this.clearEscapeTimer();
    const decoded = this.decoder.decode();
    this.decoder = new TextDecoder();
    if (decoded) this.process(decoded);
    this.clearEscapeTimer();

    const dispatchEscape = this.pending === "\x1b";
    this.pending = "";
    if (dispatchEscape) this.dispatch("\x1b");
  }

  reset(): void {
    this.clearEscapeTimer();
    this.pending = "";
    this.decoder = new TextDecoder();
  }

  private process(data: string): void {
    this.pending += data;
    let cursor = 0;
    while (cursor < this.pending.length) {
      if (this.pending[cursor] === "\x1b") {
        const token = escapeToken(this.pending, cursor);
        if (!token.complete) break;
        const sequence = this.pending.slice(cursor, token.end);
        if (isCapabilityReply(sequence)) this.forwardReply(sequence);
        else this.dispatch(sequence);
        cursor = token.end;
        continue;
      }

      const first = this.pending.charCodeAt(cursor);
      if (first >= 0xd800 && first <= 0xdbff) {
        if (cursor + 1 >= this.pending.length) break;
        const second = this.pending.charCodeAt(cursor + 1);
        if (second >= 0xdc00 && second <= 0xdfff) {
          this.dispatch(this.pending.slice(cursor, cursor + 2));
          cursor += 2;
          continue;
        }
      }
      this.dispatch(this.pending[cursor]!);
      cursor += 1;
    }
    this.pending = this.pending.slice(cursor);
    if (this.pending === "\x1b") this.armEscapeTimer();
  }

  private armEscapeTimer(): void {
    if (this.escapeTimer || this.pending !== "\x1b") return;
    this.escapeTimer = setTimeout(() => {
      this.escapeTimer = undefined;
      if (this.pending !== "\x1b") return;
      this.pending = "";
      this.dispatch("\x1b");
    }, ESCAPE_DISAMBIGUATION_MS);
    this.escapeTimer.unref?.();
  }

  private clearEscapeTimer(): void {
    if (!this.escapeTimer) return;
    clearTimeout(this.escapeTimer);
    this.escapeTimer = undefined;
  }
}

function isCapabilityReply(sequence: string): boolean {
  if (sequence.startsWith("\x1b[")) {
    const body = sequence.slice(2, -1);
    const final = sequence.at(-1);
    return (
      (final === "R" && /^\d+;\d+$/.test(body)) ||
      (final === "n" && /^\d+$/.test(body)) ||
      (final === "c" && /^[?>]?[\d;]*$/.test(body)) ||
      (final === "y" && /^\?\d+;\d+\$$/.test(body)) ||
      (final === "u" && /^\?\d+$/.test(body)) ||
      (final === "t" && /^\d+(?:;\d+)+$/.test(body))
    );
  }
  if (sequence.startsWith("\x1b]")) {
    // Terminal-originated OSC is never a keyboard event. Keep arbitrary
    // capability payloads (including text resembling Kitty release syntax)
    // away from key translation.
    return /^\d+;/.test(sequence.slice(2));
  }
  if (sequence.startsWith("\x1bP")) {
    const payload = sequence.slice(2);
    return payload.startsWith(">|") || /^[01]\+r/.test(payload);
  }
  // APC is likewise a structured terminal response, not user keyboard input.
  return sequence.startsWith("\x1b_");
}

function stripTerminalSequences(source: string): string {
  source = source.replace(/\r\n?/g, "\n");
  let output = "";
  let cursor = 0;
  while (cursor < source.length) {
    if (source[cursor] === "\x1b") {
      const token = escapeToken(source, cursor);
      cursor = token.end;
      continue;
    }
    const character = source[cursor]!;
    const code = character.charCodeAt(0);
    if (character === "\t" || character === "\n" || (code >= 32 && code !== 127)) {
      output += character;
    }
    cursor += 1;
  }
  return output;
}

function boundTerminalDetail(source: string): string | undefined {
  const lines = stripTerminalSequences(source)
    .split("\n")
    .map((line) => line.trimEnd());
  while (lines.length > 0 && !lines[0]?.trim()) lines.shift();
  while (lines.length > 0 && !lines.at(-1)?.trim()) lines.pop();
  if (lines.length === 0) return undefined;
  let detail = lines.slice(-EXIT_DETAIL_MAX_LINES).join("\n").trim();
  if (detail.length > EXIT_DETAIL_MAX_CHARS) {
    detail = `…${detail.slice(detail.length - EXIT_DETAIL_MAX_CHARS + 1)}`;
  }
  return detail || undefined;
}

/**
 * Incrementally bridges capability queries and atomically publishes the first
 * complete DEC 2026 frame. Marker prefixes are retained across arbitrary PTY
 * chunk boundaries.
 */
export class TakeoverStartupGate {
  private state: "waiting" | "frame" | "ready" = "waiting";
  private waiting = "";
  private fallbackOutput = "";
  private fallbackEligible = false;
  private frame = "";
  /** Raw pre-frame tail retained only for an actionable early child exit. */
  private exitCapture = "";
  private readonly queries: CapabilityQueryForwarder;

  constructor(
    writeQuery: (sequence: string) => void,
    private readonly publish: (frame: string) => void,
  ) {
    this.queries = new CapabilityQueryForwarder(writeQuery);
  }

  get ready(): boolean {
    return this.state === "ready";
  }

  push(text: string): TakeoverStartupEvent {
    if (this.state !== "ready" && text) {
      this.exitCapture = (this.exitCapture + text).slice(-EXIT_CAPTURE_MAX_CHARS);
    }
    if (this.state === "ready") {
      if (text) this.publish(text);
      return { ready: true, frameStarted: false, fallbackEligible: false };
    }

    if (this.state === "frame") {
      this.frame += text;
      return this.publishFrameIfComplete(true);
    }

    this.waiting += text;
    const start = this.waiting.indexOf(FRAME_START);
    if (start >= 0) {
      const prelude = this.waiting.slice(0, start);
      this.fallbackOutput += prelude;
      this.queries.push(prelude);
      this.queries.clear();
      this.frame = this.waiting.slice(start);
      this.waiting = "";
      this.state = "frame";
      return this.publishFrameIfComplete(true);
    }

    let retained = 0;
    const maximum = Math.min(FRAME_START.length - 1, this.waiting.length);
    for (let length = maximum; length > 0; length -= 1) {
      if (FRAME_START.startsWith(this.waiting.slice(-length))) {
        retained = length;
        break;
      }
    }
    const completePrelude = this.waiting.slice(0, this.waiting.length - retained);
    this.waiting = this.waiting.slice(this.waiting.length - retained);
    this.fallbackOutput += completePrelude;
    const sawRendererOutput = this.queries.push(completePrelude);
    this.fallbackEligible ||= sawRendererOutput;
    return { ready: false, frameStarted: false, fallbackEligible: this.fallbackEligible };
  }

  /** Publish a renderer-without-sync snapshot after the bounded fallback delay. */
  fallback(): boolean {
    if (this.state !== "waiting") return false;
    const output = this.fallbackOutput + this.waiting;
    this.waiting = "";
    this.fallbackOutput = "";
    this.fallbackEligible = false;
    this.queries.clear();
    this.state = "ready";
    this.publish(`\x1b[2J\x1b[H${stripCapabilityQueries(output)}`);
    return true;
  }

  /** Plain, bounded startup stderr/output for exits before a usable frame. */
  exitDetail(): string | undefined {
    return boundTerminalDetail(this.exitCapture);
  }

  reset(): void {
    this.state = "waiting";
    this.waiting = "";
    this.fallbackOutput = "";
    this.fallbackEligible = false;
    this.frame = "";
    this.exitCapture = "";
    this.queries.clear();
  }

  private publishFrameIfComplete(frameStarted: boolean): TakeoverStartupEvent {
    const end = this.frame.indexOf(FRAME_END, FRAME_START.length);
    if (end < 0) return { ready: false, frameStarted, fallbackEligible: false };
    const frameEnd = end + FRAME_END.length;
    const completeFrame = this.frame.slice(0, frameEnd);
    const trailing = this.frame.slice(frameEnd);
    this.frame = "";
    this.fallbackOutput = "";
    this.fallbackEligible = false;
    this.state = "ready";
    // A synchronized UI frame supersedes startup diagnostics; unlike fallback
    // output it is not useful as plain exit detail without a terminal emulator.
    this.exitCapture = "";
    // The placeholder was painted outside the renderer's hidden synchronized
    // prelude. Clear it atomically inside the first published transaction so a
    // cursor-home/differential frame cannot leave placeholder remnants behind.
    this.publish(`${FRAME_START}\x1b[2J\x1b[H${completeFrame.slice(FRAME_START.length)}`);
    if (trailing) this.publish(trailing);
    return { ready: true, frameStarted, fallbackEligible: false };
  }
}
