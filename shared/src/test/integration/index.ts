/**
 * Integration test helpers — barrel export.
 *
 * Import via: import { GpgCli, AssuanSocketClient, assertSafeToDelete } from '@gpg-bridge/shared/test/integration'
 *
 * GpgCli: subprocess wrappers for gpg.exe / gpgconf.exe (all phases)
 * AssuanSocketClient: Assuan protocol socket test client (Phase 2 and Phase 3)
 * assertSafeToDelete: guard for recursive directory deletion
 */

export { GpgCli } from './gpgCli';
export type { GpgCliOpts, GpgExecResult } from './gpgCli';

export { AssuanSocketClient } from './assuanSocketClient';
export type { AssuanSocketClientOpts } from './assuanSocketClient';

export { assertSafeToDelete } from './fsUtils';
