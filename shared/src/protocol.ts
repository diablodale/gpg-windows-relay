/**
 * Shared protocol utilities for Assuan/GPG protocol handling.
 * Used by both agent-proxy and request-proxy extensions.
 *
 * Key principle: All socket I/O preserves raw bytes using latin1 encoding.
 * This allows binary data (nonces, D blocks) to pass through string operations unchanged.
 */

import { LogConfig, ClientState } from './types';

/**
 * Encode a string to a Buffer using latin1 encoding.
 * latin1 preserves raw bytes without UTF-8 mangling, essential for Assuan protocol.
 *
 * @param data String data to encode
 * @returns Buffer with latin1 encoding
 */
export function encodeProtocolData(data: string): Buffer {
    return Buffer.from(data, 'latin1');
}

/**
 * Decode a Buffer to a string using latin1 encoding.
 * latin1 preserves raw bytes without UTF-8 mangling, essential for Assuan protocol.
 *
 * @param buffer Buffer to decode
 * @returns String with latin1 decoding
 */
export function decodeProtocolData(buffer: Buffer): string {
    return buffer.toString('latin1');
}

/**
 * Sanitize string for safe display in log output.
 * Shows first command word and byte count to avoid overwhelming logs with large blocks.
 *
 * Example: "INQUIRE PASSPHRASE" → "INQUIRE and 17 more bytes"
 *
 * @param str String to sanitize
 * @returns Sanitized display string
 */
export function sanitizeForLog(str: string): string {
    const firstWord = str.split(/[\s\n]/, 1)[0];
    const remainingBytes = str.length - firstWord.length - 1; // -1 for the space/newline after first word
    return `${firstWord} and ${remainingBytes} more bytes`;
}

/**
 * Log a message using the config callback if provided.
 * Replaces console.log to allow integration with VS Code output channels.
 *
 * @param config Configuration object with optional logCallback
 * @param message Message to log
 */
export function log(config: LogConfig, message: string): void {
    if (config.logCallback) {
        config.logCallback(message);
    }
}

/**
 * Safely extract error message from any error type.
 * Handles Error objects, strings, and unknown types.
 *
 * @param error Error to extract message from
 * @param fallback Optional fallback message if extraction fails or error is empty
 * @returns Error message string
 */
export function extractErrorMessage(error: unknown, fallback = 'Unknown error'): string {
    if (error == null) {
        return fallback;
    }
    if (error instanceof Error) {
        return error.message || fallback;
    }
    if (typeof error === 'object' && 'message' in error) {
        return String(error.message) || fallback;
    }
    const message = String(error);
    return message || fallback;
}

/**
 * Parse a Windows Assuan socket file format.
 * Format: ASCII port number, newline, then 16-byte binary nonce.
 *
 * @param data Buffer containing socket file contents
 * @returns Object with parsed port and nonce
 * @throws Error if format is invalid
 */
export interface ParsedSocketFile {
    port: number;
    nonce: Buffer;
}

export function parseSocketFile(data: Buffer): ParsedSocketFile {
    // Find the newline that separates port from nonce
    const newlineIndex = data.indexOf('\n');
    if (newlineIndex === -1) {
        throw new Error('Invalid socket file format: no newline found');
    }

    // Extract and parse port as ASCII
    const portStr = data.toString('utf-8', 0, newlineIndex);
    const port = parseInt(portStr, 10);

    if (isNaN(port)) {
        throw new Error(`Invalid port in socket file: ${portStr}`);
    }

    // Extract raw 16-byte nonce after the newline
    const nonceStart = newlineIndex + 1;
    const nonce = data.subarray(nonceStart, nonceStart + 16);

    if (nonce.length !== 16) {
        throw new Error(`Invalid nonce length: expected 16 bytes, got ${nonce.length}`);
    }

    return { port, nonce };
}

/**
 * Extract the next complete command from the input buffer.
 * Works in two states:
 * - SEND_COMMAND: Extract one line ending with \n
 * - INQUIRE_DATA: Extract D lines until END\n
 *
 * @param buffer Accumulated input buffer
 * @param state Current state machine state
 * @returns Object with extracted command (or null) and remaining buffer
 */
export interface CommandExtraction {
    command: string | null;
    remaining: string;
}

export function extractNextCommand(buffer: string, state: ClientState): CommandExtraction {
    if (state === 'SEND_COMMAND') {
        // Look for newline to delimit one complete command
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) {
            // Incomplete command, wait for more data
            return { command: null, remaining: buffer };
        }

        // Extract one command including the newline, keep the rest in buffer
        const command = buffer.substring(0, newlineIndex + 1);
        const remaining = buffer.substring(newlineIndex + 1);
        return { command, remaining };
    } else if (state === 'INQUIRE_DATA') {
        // Look for D lines followed by END\n marker
        const endIndex = buffer.indexOf('END\n');
        if (endIndex === -1) {
            // Incomplete D block, wait for more data
            return { command: null, remaining: buffer };
        }

        // Extract D block including END\n, keep the rest in buffer
        const command = buffer.substring(0, endIndex + 4); // "END\n" is 4 bytes
        const remaining = buffer.substring(endIndex + 4);
        return { command, remaining };
    }

    // Should not reach here if state is valid
    throw new Error(`Invalid state for command extraction: ${state}`);
}

/**
 * Determine the next state based on the response received.
 * Checks if response contains an INQUIRE directive (must be at start of line per Assuan protocol).
 *
 * @param response Response string from agent
 * @param currentState Current state (for context)
 * @returns Next state: 'INQUIRE_DATA' if INQUIRE present, otherwise 'SEND_COMMAND'
 */
export function determineNextState(response: string, currentState: ClientState): ClientState {
    // Check if response contains INQUIRE at start of line (per Assuan protocol spec)
    // This regex matches INQUIRE at the start of the string or after a newline
    if (/(^|\n)INQUIRE/.test(response)) {
        return 'INQUIRE_DATA';
    }

    // Otherwise ready for next command
    return 'SEND_COMMAND';
}
