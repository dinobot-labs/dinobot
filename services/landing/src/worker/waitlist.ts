/** Historical consent identifier retained for existing records and the privacy notice.
 * The endpoint is retired; this module contains no parsing or persistence code. */
export const CONSENT_VERSION = "waitlist-consent-v1";

/** Retained for the legacy client validator until its UI is removed. */
export const LIMITS = { emailChars: 254 } as const;
