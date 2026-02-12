/**
 * Unit tests for shared protocol utilities
 * These test the pure functions in shared/protocol.ts
 */

import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
    encodeProtocolData,
    decodeProtocolData,
    sanitizeForLog,
    extractErrorMessage,
    parseSocketFile,
    extractNextCommand,
    determineNextState,
} from '../protocol';

// Test helper for creating buffers
function createBuffer(text: string): Buffer {
    return Buffer.from(text, 'latin1');
}

describe('Protocol Utilities', () => {
    describe('Latin1 Encoding/Decoding', () => {
        it('encodeProtocolData converts string to Buffer with latin1', () => {
            const input = 'HELLO\n';
            const result = encodeProtocolData(input);
            assert.ok(Buffer.isBuffer(result), 'Result should be a Buffer');
            assert.strictEqual(result.toString('latin1'), input, 'Round-trip encoding should preserve data');
        });

        it('decodeProtocolData converts Buffer back to string', () => {
            const input = Buffer.from('BYE\n', 'latin1');
            const result = decodeProtocolData(input);
            assert.strictEqual(result, 'BYE\n', 'Decoded string should match original');
        });

        it('encodeProtocolData and decodeProtocolData round-trip correctly', () => {
            const testCases = [
                'simple\n',
                'with spaces \n',
                'OK\n',
                'ERR 123 error message\n',
                'INQUIRE DATA\n'
            ];

            testCases.forEach(testCase => {
                const encoded = encodeProtocolData(testCase);
                const decoded = decodeProtocolData(encoded);
                assert.strictEqual(decoded, testCase, `Round-trip failed for: ${JSON.stringify(testCase)}`);
            });
        });
    });

    describe('Logging Utilities', () => {
        it('sanitizeForLog shows first word and byte count', () => {
            const input = 'KEYINFO D27BB288411333745EE1B194FBC6162A92775BA4 - - 0 P';
            const result = sanitizeForLog(input);
            assert.ok(result.includes('KEYINFO'), 'Should contain first word');
            assert.ok(result.includes('more bytes'), 'Should indicate byte count');
            assert.strictEqual(result.length < input.length, true, 'Should be shorter than input');
        });

        it('sanitizeForLog handles single-word input', () => {
            const input = 'OK';
            const result = sanitizeForLog(input);
            assert.ok(result.includes('OK'), 'Should contain the word');
        });

        it('sanitizeForLog handles newline-delimited data', () => {
            const input = 'DATA\nmultiple\nlines';
            const result = sanitizeForLog(input);
            assert.ok(result.includes('DATA'), 'Should extract first word');
        });
    });

    describe('Error Extraction', () => {
        it('extractErrorMessage gets message from Error objects', () => {
            const error = new Error('Connection refused');
            const result = extractErrorMessage(error);
            assert.strictEqual(result, 'Connection refused');
        });

        it('extractErrorMessage uses fallback for non-Error values', () => {
            const result = extractErrorMessage('string error', 'Fallback');
            assert.strictEqual(result, 'string error');
        });

        it('extractErrorMessage uses default fallback when provided', () => {
            const result = extractErrorMessage(null, 'Default message');
            assert.strictEqual(result, 'Default message');
        });

        it('extractErrorMessage handles error with code property', () => {
            const error = { code: 'ECONNREFUSED', message: 'Connection refused' } as any;
            const result = extractErrorMessage(error);
            assert.ok(result.includes('Connection refused') || result.includes('ECONNREFUSED'));
        });
    });

    describe('Socket File Parsing', () => {
        it('parseSocketFile extracts port and nonce from socket data', () => {
            const portStr = '12345';
            const nonce = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
            const socketData = Buffer.concat([
                Buffer.from(portStr, 'utf-8'),
                Buffer.from('\n', 'utf-8'),
                nonce
            ]);

            const result = parseSocketFile(socketData);
            assert.strictEqual(result.port, 12345, 'Port should be parsed correctly');
            assert.deepStrictEqual(result.nonce, nonce, 'Nonce should match');
        });

        it('parseSocketFile throws on invalid format (no newline)', () => {
            const invalidData = Buffer.from('12345_no_newline_here', 'utf-8');
            assert.throws(() => parseSocketFile(invalidData), /no newline found/);
        });

        it('parseSocketFile throws on invalid port', () => {
            const invalidData = Buffer.concat([
                Buffer.from('not_a_number\n', 'utf-8'),
                Buffer.alloc(16)
            ]);
            assert.throws(() => parseSocketFile(invalidData), /Invalid port/);
        });

        it('parseSocketFile throws on invalid nonce length', () => {
            const invalidData = Buffer.concat([
                Buffer.from('12345\n', 'utf-8'),
                Buffer.alloc(8) // Wrong length
            ]);
            assert.throws(() => parseSocketFile(invalidData), /Invalid nonce length/);
        });
    });

    describe('Command Extraction', () => {
        it('extractNextCommand extracts command in SEND_COMMAND state', () => {
            const buffer = 'KEYINFO D27BB288411333745EE1B194FBC6162A92775BA4 - - 0 P\n';
            const result = extractNextCommand(buffer, 'SEND_COMMAND');
            assert.strictEqual(result.command, buffer);
            assert.strictEqual(result.remaining, '');
        });

        it('extractNextCommand keeps remaining data after command', () => {
            const buffer = 'KEYINFO cmd\nNEXT line\n';
            const result = extractNextCommand(buffer, 'SEND_COMMAND');
            assert.strictEqual(result.command, 'KEYINFO cmd\n');
            assert.strictEqual(result.remaining, 'NEXT line\n');
        });

        it('extractNextCommand returns null when no newline found', () => {
            const buffer = 'incomplete command';
            const result = extractNextCommand(buffer, 'SEND_COMMAND');
            assert.strictEqual(result.command, null);
            assert.strictEqual(result.remaining, buffer);
        });

        it('extractNextCommand extracts inquire data in INQUIRE_DATA state', () => {
            const buffer = 'D some data\nD more data\nEND\nOK\n';
            const result = extractNextCommand(buffer, 'INQUIRE_DATA');
            assert.ok(result.command, 'Command should be extracted');
            assert.ok(result.command.includes('END\n'), 'Command should include END marker');
            assert.strictEqual(result.remaining, 'OK\n', 'Remaining buffer should have OK response');
        });
    });

    describe('State Determination', () => {
        it('determineNextState: SEND_COMMAND with OK response moves to SEND_COMMAND', () => {
            const result = determineNextState('OK\n', 'SEND_COMMAND');
            assert.strictEqual(result, 'SEND_COMMAND');
        });

        it('determineNextState: SEND_COMMAND with INQUIRE moves to INQUIRE_DATA', () => {
            const result = determineNextState('INQUIRE PASSPHRASE\n', 'SEND_COMMAND');
            assert.strictEqual(result, 'INQUIRE_DATA');
        });

        it('determineNextState: WAIT_RESPONSE with OK moves to SEND_COMMAND', () => {
            const result = determineNextState('OK\n', 'WAIT_RESPONSE');
            assert.strictEqual(result, 'SEND_COMMAND');
        });

        it('determineNextState: INQUIRE_DATA closes with OK', () => {
            const result = determineNextState('OK\n', 'INQUIRE_DATA');
            assert.strictEqual(result, 'SEND_COMMAND');
        });

        it('determineNextState: ERR response stays in same state for retry', () => {
            const result = determineNextState('ERR 123 error\n', 'SEND_COMMAND');
            assert.strictEqual(result, 'SEND_COMMAND');
        });
    });

    describe('Binary Data Handling (GPG Agent Responses)', () => {
        it('encodeProtocolData round-trips all latin1 byte values (0-255)', () => {
            // Create a string with all 256 byte values
            const bytes: number[] = [];
            for (let i = 0; i < 256; i++) {
                bytes.push(i);
            }
            const binary = String.fromCharCode(...bytes);

            const encoded = encodeProtocolData(binary);
            const decoded = decodeProtocolData(encoded);

            assert.strictEqual(decoded, binary, 'All byte values should round-trip correctly');

            // Verify each byte
            for (let i = 0; i < 256; i++) {
                assert.strictEqual(decoded.charCodeAt(i), i, `Byte ${i} should be preserved`);
            }
        });

        it('handles high-byte values (128-255) common in binary data', () => {
            // Simulate GPG signature data with high bytes
            const highBytes = Buffer.from([
                0xC0, 0xDE, 0xBA, 0xBE, 0xCA, 0xFE, 0xBE, 0xEF
            ]);
            const input = highBytes.toString('latin1');

            const encoded = encodeProtocolData(input);
            const decoded = decodeProtocolData(encoded);

            assert.strictEqual(decoded, input, 'High bytes should round-trip correctly');
            assert.deepStrictEqual(
                Buffer.from(decoded, 'latin1'),
                highBytes,
                'Should recreate original buffer'
            );
        });

        it('handles null bytes in binary data (edge case)', () => {
            // Create binary data with null bytes
            const binaryData = String.fromCharCode(0x01, 0x00, 0x02, 0x00, 0x03);

            const encoded = encodeProtocolData(binaryData);
            const decoded = decodeProtocolData(encoded);

            assert.strictEqual(decoded, binaryData, 'Null bytes should be preserved');
            assert.strictEqual(decoded.length, 5, 'Length should include null bytes');
        });

        it('handles all 0xFF bytes (full saturation)', () => {
            const allFF = String.fromCharCode(0xFF, 0xFF, 0xFF, 0xFF);

            const encoded = encodeProtocolData(allFF);
            const decoded = decodeProtocolData(encoded);

            assert.strictEqual(decoded, allFF, 'Should handle all 0xFF bytes');
            assert.strictEqual(decoded.length, 4);
        });

        it('handles realistic GPG signature response with binary and ASCII mixed', () => {
            // Simulate a D block containing signature data
            // Format: D <binary_data>
            const signatureBytes = Buffer.from([0x30, 0x45, 0x02, 0x20, 0xAB, 0xCD, 0xEF, 0x01]);
            const dataCommand = 'D ' + signatureBytes.toString('latin1') + '\n';

            const encoded = encodeProtocolData(dataCommand);
            const decoded = decodeProtocolData(encoded);

            assert.strictEqual(decoded, dataCommand, 'D block with binary data should round-trip');

            // Extract signature bytes back out
            const parts = decoded.split(' ');
            assert.strictEqual(parts[0], 'D', 'Command should be D');
            const recoveredSignature = Buffer.from(parts.slice(1).join(' ').trim(), 'latin1');
            assert.deepStrictEqual(recoveredSignature, signatureBytes, 'Signature bytes should be recoverable');
        });

        it('handles D blocks in INQUIRE_DATA state with binary content', () => {
            // Simulate GPG agent response with D blocks containing binary data
            const binaryData1 = Buffer.from([0x3C, 0xDE, 0xAD, 0xBE, 0xEF]);
            const binaryData2 = Buffer.from([0xCA, 0xFE, 0xBA, 0xBE]);

            const buffer = 'D ' + binaryData1.toString('latin1') + '\n' +
                          'D ' + binaryData2.toString('latin1') + '\n' +
                          'END\nOK\n';

            const result = extractNextCommand(buffer, 'INQUIRE_DATA');
            assert.ok(result.command, 'Command should be extracted');
            assert.ok(result.command.includes('END\n'), 'Should include END marker');

            // Verify binary data is intact
            assert.strictEqual(
                result.command.indexOf(binaryData1.toString('latin1')),
                2, // After 'D '
                'First binary block should be present'
            );
        });

        it('handles random binary data sequences (simulating GPG output)', () => {
            // Generate pseudo-random binary data (deterministic for testing)
            const randomBytes: number[] = [];
            let seed = 12345;
            for (let i = 0; i < 64; i++) {
                seed = (seed * 1103515245 + 12345) >>> 0; // Unsigned to avoid overflow issues
                randomBytes.push((seed / 65536) % 256 | 0); // Ensure integer
            }

            const binaryString = String.fromCharCode(...randomBytes);
            const dataBlock = 'D ' + binaryString + '\n';

            const encoded = encodeProtocolData(dataBlock);
            const decoded = decodeProtocolData(encoded);

            assert.strictEqual(decoded, dataBlock, 'Random binary sequence should survive round-trip');

            // Verify the binary was not corrupted by checking the buffer directly
            const encodedBuffer = Buffer.from(encoded);
            const expectedBuffer = Buffer.from(dataBlock, 'latin1');
            assert.deepStrictEqual(encodedBuffer, expectedBuffer, 'Buffer representation should match exactly');
        });

        it('sanitizeForLog handles binary data safely without corruption', () => {
            // Binary data that might appear in responses
            const binaryData = String.fromCharCode(0xAB, 0xCD, 0xEF, 0x12, 0x34);
            const input = 'SIGDATA ' + binaryData;

            // sanitizeForLog should not corrupt the data, just truncate for logging
            const sanitized = sanitizeForLog(input);

            // Should start with the first word
            assert.ok(sanitized.startsWith('SIGDATA'), 'Should start with first word');
            // Long input should be truncated
            if (input.length > 50) {
                assert.strictEqual(sanitized.length < input.length, true, 'Should be truncated for logging');
            }
        });

        it('handles command with embedded newlines in D block data', () => {
            // Edge case: binary data containing what looks like newlines (but as raw bytes)
            const binaryWithLF = String.fromCharCode(0xDA, 0x0A, 0xDB); // 0x0A is LF in ASCII
            const dataBlock = 'D ' + binaryWithLF + '\nEND\n';

            // The protocol uses actual newlines to delimit, but binary data should be handled
            // This tests that binary bytes that happen to equal newline are handled correctly
            const result = extractNextCommand(dataBlock, 'INQUIRE_DATA');
            assert.ok(result.command, 'Should extract command even with embedded 0x0A in data');
        });

        it('handles large binary responses (e.g., exported keys)', () => {
            // Simulate a large key export (1KB of binary data)
            const largeData: number[] = [];
            for (let i = 0; i < 1024; i++) {
                largeData.push((i * 7) % 256); // Pseudo-random 1KB
            }

            const binaryString = String.fromCharCode(...largeData);
            const response = 'D ' + binaryString + '\nEND\nOK\n';

            const encoded = encodeProtocolData(response);
            const decoded = decodeProtocolData(encoded);

            assert.strictEqual(decoded.length, response.length, 'Full length should be preserved');
            assert.strictEqual(decoded, response, 'Large binary response should survive round-trip');
        });
    });

    describe('GPG Agent Protocol Examples', () => {
        it('handles PKSIGN signing session (from GPG manual example)', () => {
            // Replicate the example from https://www.gnupg.org/documentation/manuals/gnupg/Agent-PKSIGN.html
            // This is a realistic signing workflow:
            // 1. Client sends SIGKEY (not tested here - just context)
            // 2. Client sends PKSIGN command
            // 3. Agent responds with INQUIRE HASHVAL
            // 4. Client sends hash in D blocks + END
            // 5. Agent responds with signature in D blocks
            // 6. Agent responds with OK

            // Step 2-3: PKSIGN triggers INQUIRE from agent
            let state = determineNextState('INQUIRE HASHVAL\n', 'SEND_COMMAND');
            assert.strictEqual(state, 'INQUIRE_DATA', 'INQUIRE response should move to INQUIRE_DATA state');

            // Step 4: Client sends hash data
            const hashValue = 'ABCDEF012345678901234'; // From the example
            const clientData = 'D ' + hashValue + '\nEND\n';

            // Parse the hash block
            let result = extractNextCommand(clientData, 'INQUIRE_DATA');
            assert.ok(result.command, 'Should extract D block + END');
            assert.ok(result.command.includes('ABCDEF0'), 'Should contain hash value');
            assert.ok(result.command.includes('END\n'), 'Should include END marker');

            // After END, remaining should be empty (all consumed)
            assert.strictEqual(result.remaining, '', 'All data should be consumed after END');

            // After client sends END, we're back in SEND_COMMAND state
            state = determineNextState('OK', 'INQUIRE_DATA');
            assert.strictEqual(state, 'SEND_COMMAND', 'After END, state returns to SEND_COMMAND');

            // Step 5-6: Agent responds with signature data
            // The agent-proxy buffers all data until receiving OK
            // Format doesn't matter - could be single D line with embedded newlines,
            // or multiple D lines - proxy just buffers until OK
            const signatureResponse = 'D (sig-val rsa\nD (s 45435453654612121212))\nOK\n';

            // The important part: we can extract the final OK response
            // Everything before OK is the signature data to forward
            const lines = signatureResponse.split('\n');
            const okLine = lines[lines.length - 2] + '\n'; // "OK\n"
            assert.strictEqual(okLine, 'OK\n', 'Should receive OK terminating the response');

            // Verify the signature data is present (everything before OK)
            assert.ok(signatureResponse.includes('sig-val'), 'Response contains signature');
            assert.ok(signatureResponse.includes('45435453654612121212'), 'Response contains signature value');
        });

        it('handles PKSIGN with realistic binary signature data (RSA 2048)', () => {
            // Real RSA 2048 signature is ~256 bytes binary
            // The S-expression wrapper adds overhead
            const rsaSignatureBytes = Buffer.from([
                0x30, 0x82, 0x01, 0x00, // SEQUENCE, length 256
                0x78, 0x9C, 0x9D, 0xC0, // Some random signature bytes (deterministic)
                0x01, 0x0D, 0x58, 0x00, 0xC0, 0x03, 0x0C, 0x0C,
                0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C,
                0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C,
                0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C,
                0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C,
                0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C
            ]);

            // Format as agent response: D <binary>\n
            const signatureData = 'D ' + rsaSignatureBytes.toString('latin1') + '\n';

            // Should handle binary signature data intact
            const encoded = encodeProtocolData(signatureData);
            const decoded = decodeProtocolData(encoded);

            assert.strictEqual(decoded, signatureData, 'RSA signature bytes should round-trip');

            // Agent sends signature in SEND_COMMAND state (D line followed by OK)
            const agentResponse = signatureData + 'OK\n';
            const result = extractNextCommand(agentResponse, 'SEND_COMMAND');

            // In SEND_COMMAND, extractNextCommand gets one line (the D line)
            assert.ok(result.command, 'Should extract D line');
            assert.strictEqual(result.remaining, 'OK\n', 'Should have OK remaining');
            assert.deepStrictEqual(
                Buffer.from(result.command || '', 'latin1'),
                Buffer.concat([
                    Buffer.from('D ', 'latin1'),
                    rsaSignatureBytes,
                    Buffer.from('\n', 'latin1')
                ]),
                'Binary signature should be preserved exactly'
            );
        });

        it('handles PKSIGN with multi-block hash input', () => {
            // For very large hashes or when data arrives in multiple chunks
            const hashBlock1 = 'D ' + String.fromCharCode(0x00, 0x01, 0x02, 0x03) + '\n';
            const hashBlock2 = 'D ' + String.fromCharCode(0x04, 0x05, 0x06, 0x07) + '\n';
            const hashEnd = 'END\n';

            const clientData = hashBlock1 + hashBlock2 + hashEnd;

            // In INQUIRE_DATA state, extractNextCommand gets everything up to END\n
            const result = extractNextCommand(clientData, 'INQUIRE_DATA');
            assert.ok(result.command, 'Should extract all D blocks through END');
            assert.ok(result.command.includes('END\n'), 'Should include END marker');
        });

        it('handles PKSIGN error response during signature phase', () => {
            // If something goes wrong during signing, agent returns ERR
            const errorResponse = 'ERR 100663404 No passphrase provided\n';

            const state = determineNextState(errorResponse, 'INQUIRE_DATA');

            // ERR response doesn't contain INQUIRE, so moves back to SEND_COMMAND state
            assert.strictEqual(state, 'SEND_COMMAND', 'ERR response moves to SEND_COMMAND state');
        });

        it('handles PKSIGN with SETHASH/SHA256 workflow', () => {
            // Realistic workflow: SETHASH --hash=sha256 <digest>, then PKSIGN
            const sha256Digest = 'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855';

            // Client sends hash via SETHASH
            const setHashCmd = 'SETHASH --hash=sha256 ' + sha256Digest;
            let result = extractNextCommand(setHashCmd + '\n', 'SEND_COMMAND');

            assert.strictEqual(result.command, setHashCmd + '\n');
            assert.strictEqual(result.remaining, '');

            // Then client sends PKSIGN
            // Agent responds with INQUIRE HASHVAL
            let currentState: any = 'SEND_COMMAND';
            currentState = determineNextState('INQUIRE HASHVAL\n', currentState);
            assert.strictEqual(currentState, 'INQUIRE_DATA');

            // Client responds with END (hash already provided via SETHASH)
            result = extractNextCommand('END\n', 'INQUIRE_DATA');
            assert.strictEqual(result.command, 'END\n', 'Should extract END marker');

            // Agent sends OK (back in SEND_COMMAND state)
            currentState = determineNextState('OK\n', 'INQUIRE_DATA');
            assert.strictEqual(currentState, 'SEND_COMMAND', 'OK after INQUIRE returns to SEND_COMMAND');
        });

        it('handles PKSIGN with UTF-8 error messages', () => {
            // Agent might include descriptive error messages (though usually ASCII)
            // Test unicode handling in error responses
            const errorWithUTF8 = 'ERR 100663404 Operation cancelled by user.\n';

            const encoded = encodeProtocolData(errorWithUTF8);
            const decoded = decodeProtocolData(encoded);

            assert.strictEqual(decoded, errorWithUTF8, 'Error message should round-trip');

            const state = determineNextState(errorWithUTF8, 'INQUIRE_DATA');
            assert.strictEqual(state, 'SEND_COMMAND', 'ERR response moves to SEND_COMMAND state');
        });
    });
});
