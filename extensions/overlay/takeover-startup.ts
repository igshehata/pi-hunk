// Startup protocol gate for full-screen takeover. Capability requests must reach
// the real terminal, but no child paint is published until a complete frame.

const FRAME_START = "\x1b[?2026h";
const FRAME_END = "\x1b[?2026l";

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
      (final === "u" && body === "?") ||
      (final === "t" && /^(?:14|16|18)$/.test(body))
    );
  }
  if (sequence.startsWith("\x1b]")) return sequence.includes("?");
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

  reset(): void {
    this.state = "waiting";
    this.waiting = "";
    this.fallbackOutput = "";
    this.fallbackEligible = false;
    this.frame = "";
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
    // The placeholder was painted outside the renderer's hidden synchronized
    // prelude. Clear it atomically inside the first published transaction so a
    // cursor-home/differential frame cannot leave placeholder remnants behind.
    this.publish(`${FRAME_START}\x1b[2J\x1b[H${completeFrame.slice(FRAME_START.length)}`);
    if (trailing) this.publish(trailing);
    return { ready: true, frameStarted, fallbackEligible: false };
  }
}
