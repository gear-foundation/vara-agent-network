// Centralized IDL-driven decoder. One instance per indexed program.
//
// Exposes:
//   decoder.service(payloadHex) / decoder.event(payloadHex) — name-only sniff
//   decoder.decodeEvent<T>(event) — full typed decode from UserMessageSent
//
// The IDL is parsed once at startup. Decoding is then pure — no RPC, no state.
import { existsSync, readFileSync } from "node:fs";
import { getFnNamePrefix, getServiceNamePrefix, Sails } from "sails-js";
import { SailsIdlParser } from "sails-js-parser";
import type { DecodedEvent, Hex, UserMessageSentEvent } from "../helpers/types.js";

export class SailsDecoder {
  private constructor(private readonly program: Sails) {}

  static async fromIdlFile(idlPath: string): Promise<SailsDecoder> {
    if (!existsSync(idlPath)) {
      throw new Error(`IDL not found: ${idlPath}`);
    }
    const parser = await SailsIdlParser.new();
    const sails = new Sails(parser);
    sails.parseIdl(readFileSync(idlPath, "utf8"));
    return new SailsDecoder(sails);
  }

  /** Returns service-name prefix ("Registry", "Chat", "Board"). */
  service(payload: Hex): string {
    return getServiceNamePrefix(payload);
  }

  /** Returns event-or-fn-name prefix ("ApplicationRegistered", etc.). */
  eventName(payload: Hex): string {
    return getFnNamePrefix(payload);
  }

  /** Decode a Sails event from a UserMessageSent payload. Returns null if
   *  the service/event pair is not known to the IDL (e.g. on IDL drift). */
  decodeEvent<T = unknown>(event: UserMessageSentEvent): DecodedEvent<T> | null {
    const payload = event.payload;
    const service = this.service(payload);
    const ev = this.eventName(payload);
    const spec = this.program.services?.[service]?.events?.[ev];
    if (!spec) return null;
    const decoded = spec.decode(payload) as T;
    return { service, event: ev, payload: decoded };
  }
}
