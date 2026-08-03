/**
 * Directory entries in a platform-independent order.
 *
 * Declared in the SDK beside the discovery walk that reads directories with it: node insertion
 * follows discovery order, so a producer that enumerated its own way would make node order a
 * property of the host filesystem. Re-exported here so engine callers outside discovery — the build
 * fingerprint, threshold groups — read directories the same way.
 */
export { readDirSorted } from '@repovine/plugin-sdk';
