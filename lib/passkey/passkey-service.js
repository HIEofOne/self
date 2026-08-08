/**
 * WebAuthn/passkey service for MAIA
 */

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import '@simplewebauthn/server/helpers';
import { isoBase64URL } from "@simplewebauthn/server/helpers";

export class PasskeyService {
  constructor(options = {}) {
    this.rpName = options.rpName || "HIEofOne.org";
    this.rpID = options.rpID || process.env.PASSKEY_RPID || 'localhost';
    this.origin = options.origin || process.env.PASSKEY_ORIGIN || 'http://localhost:3001';
    const envOrigins = process.env.PASSKEY_ORIGINS
      ? process.env.PASSKEY_ORIGINS.split(',').map(entry => entry.trim()).filter(Boolean)
      : [];
    this.allowedOrigins = Array.isArray(options.allowedOrigins) && options.allowedOrigins.length > 0
      ? options.allowedOrigins
      : (envOrigins.length > 0 ? envOrigins : [this.origin]);
  }

  resolveExpectedOrigin(originHeader) {
    if (!originHeader) {
      return this.origin;
    }
    let normalized = null;
    try {
      normalized = new URL(originHeader).origin;
    } catch (error) {
      throw new Error('Invalid origin');
    }
    const allowed = this.allowedOrigins
      .map(origin => {
        try {
          return new URL(origin).origin;
        } catch (err) {
          return null;
        }
      })
      .filter(Boolean);
    if (allowed.includes(normalized)) {
      return normalized;
    }
    throw new Error('Origin not allowed');
  }

  /**
   * Generate registration options for a new passkey
   */
  async generateRegistrationOptions(params) {
    const { userId, displayName } = params;

    if (!userId || !displayName) {
      throw new Error('userId and displayName are required');
    }

    // Validate userId format
    if (userId.length < 3) {
      throw new Error('User ID must be at least 3 characters');
    }
    if (userId.length > 20) {
      throw new Error('User ID must be 20 characters or less');
    }
    if (!/^[a-z0-9-]+$/.test(userId)) {
      throw new Error('User ID must contain only lowercase letters, numbers, and hyphens');
    }
    if (userId.startsWith('-') || userId.endsWith('-')) {
      throw new Error('User ID cannot start or end with a hyphen');
    }

    // HOST-QUALIFIED user handle. Authenticators keep exactly ONE
    // discoverable credential per (rpID, user.id) pair, and our rpID is
    // the REGISTRABLE domain (agropper.xyz) shared by every deployment on
    // its subdomains. With a bare user.id of "admin", creating a passkey
    // on test.agropper.xyz silently EVICTED the maia.agropper.xyz admin
    // passkey from the authenticator (and vice versa) — each server only
    // accepts its own stored credentialID, so the other host's login
    // broke every time: the "admin passkeys keep getting lost" ping-pong.
    // Qualifying the handle with this deployment's hostname gives each
    // host its own (rpID, user.id) slot, so the credentials coexist.
    // Existing credentials keep working — authentication matches on
    // allowCredentials/credentialID and the server never reads
    // response.userHandle — only NEW registrations get the new handle.
    const host = (() => {
      try { return new URL(this.origin).hostname; } catch { return this.rpID; }
    })();
    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpID,
      userID: Buffer.from(`${userId}@${host}`, 'utf8'),
      // The picker label — make the host visible so two hosts' passkeys
      // are distinguishable in Chrome/iCloud Keychain.
      userName: `${userId}@${host}`,
      userDisplayName: displayName === userId ? `${displayName} (${host})` : displayName,
      attestationType: "none", // v13 option name (the old `attestation` key was silently ignored)
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
        // Do not set authenticatorAttachment: "platform" — allows cross-device (e.g. phone)
        // when the device has no platform authenticator (e.g. 2015 Mac Mini without Touch ID).
        // UV required so we never accept a credential created without verification (e.g. software-only).
      },
    });

    return options;
  }

  /**
   * Verify registration response
   */
  async verifyRegistration(params) {
    const { response, expectedChallenge, userDoc, expectedOrigin } = params;

    if (!response || !expectedChallenge) {
      throw new Error('response and expectedChallenge are required');
    }

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: expectedOrigin || this.origin,
      expectedRPID: this.rpID,
      requireUserVerification: true,
    });

    if (!verification.verified) {
      throw new Error('Registration verification failed');
    }

    // Build credential info for storage
    const credentialInfo = {
      credentialID: verification.registrationInfo.credential.id,
      credentialPublicKey: isoBase64URL.fromBuffer(verification.registrationInfo.credential.publicKey),
      counter: verification.registrationInfo.credential.counter,
      transports: response.response.transports || [],
    };

    return {
      verified: true,
      credentialInfo,
      userDoc: userDoc ? { ...userDoc, ...credentialInfo } : null
    };
  }

  /**
   * Generate authentication options for passkey login
   */
  async generateAuthenticationOptions(params) {
    const { userId, userDoc } = params;

    if (!userDoc || !userDoc.credentialID) {
      throw new Error('User does not have a registered passkey');
    }

    // Build allowed credential from user doc
    const allowedCredential = {
      id: userDoc.credentialID,
      type: 'public-key',
      transports: userDoc.transports || [],
    };

    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      allowCredentials: [allowedCredential],
      userVerification: 'required',
      timeout: 60000,
      // Do not restrict to platform — allow passkeys created on phone/other device.
    });

    return options;
  }

  /**
   * Verify authentication response
   */
  async verifyAuthentication(params) {
    const { response, expectedChallenge, userDoc, expectedOrigin } = params;

    if (!response || !expectedChallenge || !userDoc) {
      throw new Error('response, expectedChallenge, and userDoc are required');
    }

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: expectedOrigin || this.origin,
      expectedRPID: this.rpID,
      credential: {
        id: userDoc.credentialID,
        publicKey: isoBase64URL.toBuffer(userDoc.credentialPublicKey),
        counter: userDoc.counter || 0,
      },
      requireUserVerification: true,
    });

    if (!verification.verified) {
      throw new Error('Authentication verification failed');
    }

    // Update counter
    const updatedUserDoc = {
      ...userDoc,
      counter: verification.authenticationInfo.newCounter,
    };

    return {
      verified: true,
      userDoc: updatedUserDoc,
    };
  }
}

