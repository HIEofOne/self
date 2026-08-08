/**
 * Regression test for the cross-host passkey eviction bug: two MAIA
 * deployments on subdomains of one registrable domain share a WebAuthn
 * rpID (agropper.xyz), and authenticators keep exactly ONE discoverable
 * credential per (rpID, user handle). With a bare handle of "admin",
 * registering on test.agropper.xyz evicted the maia.agropper.xyz admin
 * passkey from the authenticator and vice versa — the "admin passkeys
 * keep getting lost" ping-pong.
 *
 * The fix host-qualifies the handle, so each deployment claims its own
 * (rpID, user.id) slot and the credentials coexist.
 */
import { describe, it, expect } from 'vitest';
import { PasskeyService } from '../../lib/passkey/index.js';

const decodeUserId = (options) =>
  Buffer.from(options.user.id, 'base64url').toString('utf8');

describe('host-qualified WebAuthn user handles', () => {
  it('two hosts sharing an rpID register DISTINCT user handles for the same userId', async () => {
    const maia = new PasskeyService({ rpID: 'agropper.xyz', origin: 'https://maia.agropper.xyz' });
    const test = new PasskeyService({ rpID: 'agropper.xyz', origin: 'https://test.agropper.xyz' });

    const a = await maia.generateRegistrationOptions({ userId: 'admin', displayName: 'admin' });
    const b = await test.generateRegistrationOptions({ userId: 'admin', displayName: 'admin' });

    // Same relying party — the shared registrable domain is unchanged...
    expect(a.rp.id).toBe('agropper.xyz');
    expect(b.rp.id).toBe('agropper.xyz');
    // ...but the (rpID, user.id) pairs no longer collide, so a passkey
    // created on one host can never evict the other host's.
    expect(decodeUserId(a)).toBe('admin@maia.agropper.xyz');
    expect(decodeUserId(b)).toBe('admin@test.agropper.xyz');
    expect(a.user.id).not.toBe(b.user.id);

    // The picker label carries the host so the two are distinguishable.
    expect(a.user.name).toBe('admin@maia.agropper.xyz');
    expect(b.user.name).toBe('admin@test.agropper.xyz');
    expect(a.user.displayName).toBe('admin (maia.agropper.xyz)');
  });

  it('discoverable-credential posture is unchanged (residentKey preferred, UV required)', async () => {
    const svc = new PasskeyService({ rpID: 'agropper.xyz', origin: 'https://maia.agropper.xyz' });
    const o = await svc.generateRegistrationOptions({ userId: 'jessica76', displayName: 'jessica76' });
    expect(o.authenticatorSelection.residentKey).toBe('preferred');
    expect(o.authenticatorSelection.userVerification).toBe('required');
    expect(decodeUserId(o)).toBe('jessica76@maia.agropper.xyz');
  });

  it('a distinct displayName is preserved verbatim (only userId-as-displayName gets the host suffix)', async () => {
    const svc = new PasskeyService({ rpID: 'agropper.xyz', origin: 'https://maia.agropper.xyz' });
    const o = await svc.generateRegistrationOptions({ userId: 'jessica76', displayName: 'Jessica R.' });
    expect(o.user.displayName).toBe('Jessica R.');
    expect(o.user.name).toBe('jessica76@maia.agropper.xyz');
  });

  it('an unparsable origin falls back to the rpID for the handle host', async () => {
    const svc = new PasskeyService({ rpID: 'localhost', origin: 'not a url' });
    const o = await svc.generateRegistrationOptions({ userId: 'admin', displayName: 'admin' });
    expect(decodeUserId(o)).toBe('admin@localhost');
  });
});
